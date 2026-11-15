import { loadFont as loadSerif } from "@remotion/google-fonts/InstrumentSerif";
import { loadFont as loadSans } from "@remotion/google-fonts/Inter";
import { Easing, interpolate } from "remotion";

export const serif = loadSerif("normal", { weights: ["400"], subsets: ["latin"] }).fontFamily;
loadSerif("italic", { weights: ["400"], subsets: ["latin"] });
export const fontFamily = loadSans("normal", { weights: ["400", "500", "600", "700"], subsets: ["latin"] }).fontFamily;
export const mono = "Consolas, 'Cascadia Mono', monospace";

export const C = {
  bg: "#FBFAF8",
  white: "#FFFFFF",
  ink: "#191919",
  muted: "#6E6E6E",
  faint: "#A6A6A6",
  line: "#ECEAE6",
  soft: "#F4F3F0",
  good: "#1F9D63",
  goodBg: "#E8F6EE",
  bad: "#D4483B",
  badBg: "#FCECEA",
  warn: "#B7791F",
  warnBg: "#FFF4DB",
  hl: "#FFE49A",
  kite: "#5B5BF7",
};

export const FPS = 30;
export const W = 1920;
export const H = 1080;

export const pop = (t: number, at: number, dur = 0.55) =>
  interpolate(t, [at, at + dur], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.out(Easing.back(1.4)) });
export const ease = (t: number, at: number, dur = 0.6) =>
  interpolate(t, [at, at + dur], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.out(Easing.cubic) });
export const inOut = (t: number, at: number, dur = 0.8) =>
  interpolate(t, [at, at + dur], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.inOut(Easing.cubic) });
export const range = (t: number, a: number, b: number, from: number, to: number) =>
  interpolate(t, [a, b], [from, to], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.inOut(Easing.cubic) });

export type Beat = { id: string; scene: string; text: string; seconds: number; words: number };
export type Placed = Beat & { start: number; end: number };
export type BeatT = { s: number; d: number; text: string };
export type SceneBeats = Record<string, BeatT>;

/** Seconds (scene-relative) when a keyword in a beat is spoken, estimated from its position in the text. */
export const at = (b: BeatT, key: string, lead = 0.15) => {
  const i = b.text.toLowerCase().indexOf(key.toLowerCase());
  return b.s + Math.max(0, (i < 0 ? 0 : i / b.text.length) * b.d - lead);
};
