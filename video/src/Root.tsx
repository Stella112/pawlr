import React from "react";
import { Composition } from "remotion";
import { Demo, place } from "./Demo";
import { FPS, H, W } from "./theme";

export const Root: React.FC = () => (
  <Composition id="Demo" component={Demo} durationInFrames={Math.ceil(place().total * FPS)} fps={FPS} width={W} height={H} />
);
