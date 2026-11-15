import React from "react";
import { AbsoluteFill, Audio, Sequence, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import beatsJson from "../beats.json";
import { Close, Explorer, Hook, How, Judge, Live, Pitch, Proof, Recover } from "./scenes";
import { Beat, C, FPS, Placed, SceneBeats, ease, fontFamily } from "./theme";
import { useT } from "./ui";

const GAP = 0.35;
const TAIL = 1.8;

export const place = (): { beats: Placed[]; total: number } => {
  let t = 0.3;
  const beats = (beatsJson as Beat[]).map((b) => {
    const p = { ...b, start: t, end: t + b.seconds };
    t += b.seconds + GAP;
    return p;
  });
  return { beats, total: t - GAP + TAIL };
};

const SCENES: [string, React.FC<{ B: SceneBeats }>][] = [
  ["hook", Hook],
  ["pitch", Pitch],
  ["live", Live],
  ["explorer", Explorer],
  ["how", How],
  ["judge", Judge],
  ["proof", Proof],
  ["recover", Recover],
  ["close", Close],
];

const SENT = /(?<=[.?!:])\s+/;
const chunks = (text: string) => {
  const out: string[] = [];
  for (const s of text.split(SENT)) {
    if (s.length <= 80) out.push(s);
    else {
      const parts = s.split(/,\s+/);
      let cur = "";
      for (const p of parts) {
        if ((cur + ", " + p).length > 80 && cur) {
          out.push(cur + ",");
          cur = p;
        } else cur = cur ? cur + ", " + p : p;
      }
      if (cur) out.push(cur);
    }
  }
  return out;
};

const Captions: React.FC<{ beats: Placed[]; dark: (t: number) => boolean }> = ({ beats, dark }) => {
  const f = useCurrentFrame();
  const t = f / FPS;
  const b = beats.find((x) => t >= x.start - 0.05 && t < x.end + 0.05);
  if (!b) return null;
  const cs = chunks(b.text);
  const total = cs.reduce((a, c) => a + c.length, 0);
  let acc = b.start;
  let cur = cs[cs.length - 1];
  for (const c of cs) {
    const d = (c.length / total) * b.seconds;
    if (t < acc + d) {
      cur = c;
      break;
    }
    acc += d;
  }
  const dk = dark(t);
  return (
    <div style={{ position: "absolute", left: 0, right: 0, bottom: 34, display: "flex", justifyContent: "center", pointerEvents: "none" }}>
      <div style={{ maxWidth: 1500, background: dk ? "rgba(255,255,255,.92)" : "rgba(25,25,25,.86)", color: dk ? C.ink : "#fff", fontFamily, fontSize: 34, fontWeight: 500, lineHeight: 1.3, textAlign: "center", padding: "12px 30px", borderRadius: 22 }}>{cur}</div>
    </div>
  );
};

const Fade: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const t = useT();
  return <AbsoluteFill style={{ opacity: ease(t, 0, 0.35) }}>{children}</AbsoluteFill>;
};

export const Demo: React.FC = () => {
  const { beats, total } = place();
  const f = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const groups = SCENES.map(([id, Comp]) => {
    const mine = beats.filter((b) => b.scene === id);
    return { id, Comp, mine, start: mine[0].start };
  });
  const bounds = groups.map((g, i) => ({ id: g.id, start: i === 0 ? 0 : g.start - 0.15, end: i === groups.length - 1 ? total : groups[i + 1].start - 0.15 }));
  const ex = bounds.find((b) => b.id === "explorer")!;
  return (
    <AbsoluteFill style={{ fontFamily, background: C.bg }}>
      {groups.map((g, i) => {
        const { start, end } = bounds[i];
        const B: SceneBeats = {};
        for (const b of g.mine) B[b.id] = { s: b.start - start, d: b.seconds, text: b.text };
        const from = Math.round(start * fps);
        const dur = Math.max(1, Math.round(end * fps) - from);
        return (
          <Sequence key={g.id} from={from} durationInFrames={dur}>
            <Fade>
              <g.Comp B={B} />
            </Fade>
          </Sequence>
        );
      })}
      {beats.map((b) => (
        <Sequence key={b.id} from={Math.round(b.start * fps)} durationInFrames={Math.ceil(b.seconds * fps) + 2}>
          <Audio src={staticFile(`audio/${b.id}.mp3`)} />
        </Sequence>
      ))}
      <Captions beats={beats} dark={(t) => t >= ex.start && t < ex.end} />
      <div style={{ position: "absolute", left: 0, bottom: 0, height: 6, width: `${(f / durationInFrames) * 100}%`, background: C.bad }} />
    </AbsoluteFill>
  );
};
