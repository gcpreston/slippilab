import { createContext, useContext } from "solid-js";
import { PlaybackType } from "~/state/playback";

const PlaybackContext = createContext<PlaybackType>("replay");

// TODO: Figure out where this default value lives
export const PlaybackProvider = (props) => {
  <PlaybackContext.Provider value="replay">
    {props.children}
  </PlaybackContext.Provider>
};

export const usePlayback = () => useContext(PlaybackContext);
