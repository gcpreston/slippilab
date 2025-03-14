import createRAF, { targetFPS } from "@solid-primitives/raf";
import { batch, createEffect, createResource } from "solid-js";
import { createStore } from "solid-js/store";
import {
  ActionName,
  actionNameById,
  AttackName,
  characterNameByExternalId,
  characterNameByInternalId,
} from "~/common/ids";
import {
  Frame,
  PlayerInputs,
  PlayerSettings,
  PlayerState,
  PlayerUpdate,
  PlayerUpdateWithNana,
  SpectateData,
} from "~/common/types";
import { parseReplay } from "~/parser/parser";
import { queries } from "~/search/queries";
import { Highlight, search } from "~/search/search";
import { CharacterAnimations, fetchAnimations } from "~/viewer/animationCache";
import { actionMapByInternalId } from "~/viewer/characters";
import { Character } from "~/viewer/characters/character";
import { getPlayerOnFrame, getStartOfAction } from "~/viewer/viewerUtil";
import colors from "tailwindcss/colors";
import { action, landsAttack } from "~/search/framePredicates";
import { decode } from "@shelacek/ubjson";
import { parseFirstFrame, parseFrame } from "~/parser/liveParser";

export interface RenderData {
  playerState: PlayerState;
  playerInputs: PlayerInputs;
  playerSettings: PlayerSettings;

  // main render
  path?: string;
  innerColor: string;
  outerColor: string;
  transforms: string[];

  // shield/shine renders
  animationName: string;
  characterData: Character;
}

export interface SpectateStore {
  spectateData?: SpectateData;
  highlights: Record<string, Highlight[]>;
  selectedHighlight?: [string, Highlight];
  animations: (CharacterAnimations | undefined)[];
  frame: number;
  renderDatas: RenderData[];
  fps: number;
  framesPerTick: number;
  running: boolean;
  zoom: number;
  isDebug: boolean;
  isFullscreen: boolean;
  customAction: ActionName;
  customAttack: AttackName;

  // IDEA
  // - Here, hold frames which have not yet been played + unfinalized ones
  // - on state update, play the first one
}
export const defaultReplayStoreState: SpectateStore = {
  highlights: Object.fromEntries(
    Object.entries(queries).map(([name]) => [name, []])
  ),
  frame: 0,
  renderDatas: [],
  animations: Array(4).fill(undefined),
  fps: 60,
  framesPerTick: 1,
  running: false,
  zoom: 1,
  isDebug: false,
  isFullscreen: false,
  customAction: "Passive",
  customAttack: "Up Tilt",
};

const [replayState, setReplayState] = createStore<SpectateStore>(
  defaultReplayStoreState
);

export const spectateStore = replayState;

// Highlight code removed

export function speedNormal(): void {
  batch(() => {
    setReplayState("fps", 60);
    setReplayState("framesPerTick", 1);
  });
}

export function speedFast(): void {
  setReplayState("framesPerTick", 2);
}

export function speedSlow(): void {
  setReplayState("fps", 30);
}

export function zoomIn(): void {
  setReplayState("zoom", (z) => z * 1.01);
}

export function zoomOut(): void {
  setReplayState("zoom", (z) => z / 1.01);
}

export function toggleDebug(): void {
  setReplayState("isDebug", (isDebug) => !isDebug);
}

export function toggleFullscreen(): void {
  setReplayState("isFullscreen", (isFullscreen) => !isFullscreen);
}

export function jump(target: number): void {
  setReplayState("frame", wrapFrame(replayState, target));
}

// jumpPercent removed

export function adjust(delta: number): void {
  setReplayState("frame", (f) => wrapFrame(replayState, f + delta));
}

/* IDEA
 * Due to network, frames will not arrive perfectly on time.
 * Create a buffer that we pop from at this rate.
 * For first pass, maybe just display frame as soon as it's in and parsed.
 */
/*
const [running, start, stop] = createRAF(
  targetFPS(
    () =>
      setReplayState("frame", (f) =>
        wrapFrame(replayState, f + replayState.framesPerTick)
      ),
    () => replayState.fps
  )
);
createEffect(() => setReplayState("running", running()));
*/

// runs based on frames changes rn
// probably want to change that
createEffect(() => {
  if (replayState.spectateData) {
    const frameCount = replayState.spectateData.frames.length;
    setReplayState("frame", frameCount);
  }
});

// on initial load: connect to websocket, define callbacks
//   - initialize empty SpectateStore
//   - expect first packets first
//   - parseFrame for subsequent packets; add to SpectateStore
//   - replay running effect should depend on spectateStore.frames (run the last frame always?)

// ------------------------------------
// WebSocket one-time setup logic
// TODO: Error handling
console.log('initializing ws connection')
const ws = new WebSocket('ws://localhost:5197');
var seenGameStart = false;

ws.onerror = (e) => {
  console.log('WebSocket error:', e);
};

ws.onmessage = ({ data }: { data: Blob }) => {
  if (seenGameStart) { // (replayState.spectateData) {
    // Receive subsequent frames
    data.arrayBuffer()
      .then((buf) => {
        debugger;
        const [type, data] = parseFrame(
          new Uint8Array(buf),
          replayState.spectateData!.replayVersion,
          replayState.spectateData!.frames
        );

        let newSpectateData: SpectateData;

        switch (type) {
          case "frame":
            const frame = data;
            newSpectateData = {
              ...spectateStore.spectateData!,
              frames: [...replayState.spectateData!.frames, frame]
            };
            break;
          case "game_ending":
            const ending = data;
            newSpectateData = {
              ...spectateStore.spectateData!,
              ending
            };
            break;
        }

        setReplayState("spectateData", newSpectateData);
      });
  } else {
    // Receive initial frame
    data.arrayBuffer()
      .then((buf) => {
        debugger;
        const settings = parseFirstFrame(new Uint8Array(buf));
        const replayVersion = settings.replayFormatVersion;
        const frames: Frame[] = [];

        const initialSpectateData: SpectateData = { settings, frames, replayVersion };

        setReplayState("spectateData", initialSpectateData);
        seenGameStart = true;
        console.log("initialized spectateData", initialSpectateData);
      });
  }
};
// -------------------------

const animationResources = [];
for (let playerIndex = 0; playerIndex < 4; playerIndex++) {
  animationResources.push(
    createResource(
      () => {
        const replay = replayState.spectateData;
        if (replay === undefined) {
          return undefined;
        }
        const playerSettings = replay.settings.playerSettings[playerIndex];
        if (playerSettings === undefined) {
          return undefined;
        }
        const playerUpdate =
          replay.frames[replayState.frame].players[playerIndex];
        if (playerUpdate === undefined) {
          return playerSettings.externalCharacterId;
        }
        if (
          playerUpdate.state.internalCharacterId ===
          characterNameByInternalId.indexOf("Zelda")
        ) {
          return characterNameByExternalId.indexOf("Zelda");
        }
        if (
          playerUpdate.state.internalCharacterId ===
          characterNameByInternalId.indexOf("Sheik")
        ) {
          return characterNameByExternalId.indexOf("Sheik");
        }
        return playerSettings.externalCharacterId;
      },
      (id) => (id === undefined ? undefined : fetchAnimations(id))
    )
  );
}
animationResources.forEach(([dataSignal], playerIndex) =>
  createEffect(() =>
    // I can't use the obvious setReplayState("animations", playerIndex,
    // dataSignal()) because it will merge into the previous animations data
    // object, essentially overwriting the previous characters animation data
    // forever
    setReplayState("animations", (animations) => {
      const newAnimations = [...animations];
      newAnimations[playerIndex] = dataSignal();
      return newAnimations;
    })
  )
);

createEffect(() => {
  if (replayState.spectateData === undefined) {
    return;
  }
  setReplayState(
    "renderDatas",
    replayState.spectateData.frames[replayState.frame].players
      .filter((playerUpdate) => playerUpdate)
      .flatMap((playerUpdate) => {
        const animations = replayState.animations[playerUpdate.playerIndex];
        if (animations === undefined) return [];
        const renderDatas = [];
        renderDatas.push(
          computeRenderData(replayState, playerUpdate, animations, false)
        );
        if (playerUpdate.nanaState != null) {
          renderDatas.push(
            computeRenderData(replayState, playerUpdate, animations, true)
          );
        }
        return renderDatas;
      })
  );
});

function computeRenderData(
  replayState: SpectateStore,
  playerUpdate: PlayerUpdate,
  animations: CharacterAnimations,
  isNana: boolean
): RenderData {
  const playerState = (playerUpdate as PlayerUpdateWithNana)[
    isNana ? "nanaState" : "state"
  ];
  const playerInputs = (playerUpdate as PlayerUpdateWithNana)[
    isNana ? "nanaInputs" : "inputs"
  ];
  const playerSettings = replayState
    .spectateData!.settings.playerSettings.filter(Boolean)
    .find((settings) => settings.playerIndex === playerUpdate.playerIndex)!;

  const startOfActionPlayerState: PlayerState = (
    getPlayerOnFrame(
      playerUpdate.playerIndex,
      getStartOfAction(playerState, replayState.spectateData!),
      replayState.spectateData!
    ) as PlayerUpdateWithNana
  )[isNana ? "nanaState" : "state"];
  const actionName = actionNameById[playerState.actionStateId];
  const characterData = actionMapByInternalId[playerState.internalCharacterId];
  const animationName =
    characterData.animationMap.get(actionName) ??
    characterData.specialsMap.get(playerState.actionStateId) ??
    actionName;
  const animationFrames = animations[animationName];
  // TODO: validate L cancels, other fractional frames, and one-indexed
  // animations. I am currently just flooring. Converts - 1 to 0 and loops for
  // Entry, Guard, etc.
  const frameIndex =
    Math.floor(Math.max(0, playerState.actionStateFrameCounter)) %
    (animationFrames?.length ?? 1);
  // To save animation file size, duplicate frames just reference earlier
  // matching frames such as "frame20".
  const animationPathOrFrameReference = animationFrames?.[frameIndex];
  const path =
    animationPathOrFrameReference !== undefined &&
    (animationPathOrFrameReference.startsWith("frame") ?? false)
      ? animationFrames?.[
          Number(animationPathOrFrameReference.slice("frame".length))
        ]
      : animationPathOrFrameReference;
  const rotation =
    animationName === "DamageFlyRoll"
      ? getDamageFlyRollRotation(replayState, playerState)
      : isSpacieUpB(playerState)
      ? getSpacieUpBRotation(replayState, playerState)
      : 0;
  // Some animations naturally turn the player around, but facingDirection
  // updates partway through the animation and incorrectly flips the
  // animation. The solution is to "fix" the facingDirection for the duration
  // of the action, as the animation expects. However upB turnarounds and
  // Jigglypuff/Kirby mid-air jumps are an exception where we need to flip
  // based on the updated state.facingDirection.
  const facingDirection = actionFollowsFacingDirection(animationName)
    ? playerState.facingDirection
    : startOfActionPlayerState.facingDirection;
  return {
    playerState,
    playerInputs,
    playerSettings,
    path,
    innerColor: getPlayerColor(
      replayState,
      playerUpdate.playerIndex,
      playerState.isNana
    ),
    outerColor:
      startOfActionPlayerState.lCancelStatus === "missed"
        ? "red"
        : playerState.hurtboxCollisionState !== "vulnerable"
        ? "blue"
        : "black",
    transforms: [
      `translate(${playerState.xPosition} ${playerState.yPosition})`,
      // TODO: rotate around true character center instead of current guessed
      // center of position+(0,8)
      `rotate(${rotation} 0 8)`,
      `scale(${characterData.scale} ${characterData.scale})`,
      `scale(${facingDirection} 1)`,
      "scale(.1 -.1) translate(-500 -500)",
    ],
    animationName,
    characterData,
  };
}

// DamageFlyRoll default rotation is (0,1), but we calculate rotation from (1,0)
// so we need to subtract 90 degrees. Quick checks:
// 0 - 90 = -90 which turns (0,1) into (1,0)
// -90 - 90 = -180 which turns (0,1) into (-1,0)
// Facing direction is handled naturally because the rotation will go the
// opposite direction (that scale happens first) and the flip of (0,1) is still
// (0, 1)
function getDamageFlyRollRotation(
  replayState: SpectateStore,
  playerState: PlayerState
): number {
  const previousState = (
    getPlayerOnFrame(
      playerState.playerIndex,
      playerState.frameNumber - 1,
      replayState.spectateData!
    ) as PlayerUpdateWithNana
  )[playerState.isNana ? "nanaState" : "state"];
  const deltaX = playerState.xPosition - previousState.xPosition;
  const deltaY = playerState.yPosition - previousState.yPosition;
  return (Math.atan2(deltaY, deltaX) * 180) / Math.PI - 90;
}

// Rotation will be whatever direction the player was holding at blastoff. The
// default rotation of the animation is (1,0), so we need to subtract 180 when
// facing left, and subtract 0 when facing right.
// Quick checks:
// 0 - 0 = 0, so (1,0) is unaltered when facing right
// 0 - 180 = -180, so (1,0) is flipped when facing left
function getSpacieUpBRotation(
  replayState: SpectateStore,
  playerState: PlayerState
): number {
  const startOfActionPlayer = getPlayerOnFrame(
    playerState.playerIndex,
    getStartOfAction(playerState, replayState.spectateData!),
    replayState.spectateData!
  );
  const joystickDegrees =
    ((startOfActionPlayer.inputs.processed.joystickY === 0 &&
    startOfActionPlayer.inputs.processed.joystickX === 0
      ? Math.PI / 2
      : Math.atan2(
          startOfActionPlayer.inputs.processed.joystickY,
          startOfActionPlayer.inputs.processed.joystickX
        )) *
      180) /
    Math.PI;
  return (
    joystickDegrees -
    ((startOfActionPlayer as PlayerUpdateWithNana)[
      playerState.isNana ? "nanaState" : "state"
    ].facingDirection === -1
      ? 180
      : 0)
  );
}

// All jumps and upBs either 1) Need to follow the current frame's
// facingDirection, or 2) Won't have facingDirection change during the action.
// In either case we can grab the facingDirection from the current frame.
function actionFollowsFacingDirection(animationName: string): boolean {
  return (
    animationName.includes("Jump") ||
    ["SpecialHi", "SpecialAirHi"].includes(animationName)
  );
}

function isSpacieUpB(playerState: PlayerState): boolean {
  const character = characterNameByInternalId[playerState.internalCharacterId];
  return (
    ["Fox", "Falco"].includes(character) &&
    [355, 356].includes(playerState.actionStateId)
  );
}

export function getPlayerColor(
  replayState: SpectateStore,
  playerIndex: number,
  isNana: boolean
): string {
  if (replayState.spectateData!.settings.isTeams) {
    const settings =
      replayState.spectateData!.settings.playerSettings[playerIndex];
    return [
      [colors.red["800"], colors.red["600"]],
      [colors.green["800"], colors.green["600"]],
      [colors.blue["800"], colors.blue["600"]],
    ][settings.teamId][isNana ? 1 : settings.teamShade];
  }
  return [
    [colors.red["700"], colors.red["600"]],
    [colors.blue["700"], colors.blue["600"]],
    [colors.yellow["500"], colors.yellow["400"]],
    [colors.green["700"], colors.green["600"]],
  ][playerIndex][isNana ? 1 : 0];
}

function wrapFrame(replayState: SpectateStore, frame: number): number {
  if (!replayState.spectateData) return frame;
  return (
    (frame + replayState.spectateData.frames.length) %
    replayState.spectateData.frames.length
  );
}

function wrapHighlight(replayState: SpectateStore, highlight: number): number {
  const length = Object.entries(replayState.highlights).flatMap(
    ([name, highlights]) => highlights
  ).length;
  return (highlight + length) % length;
}
