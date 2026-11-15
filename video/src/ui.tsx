import React from "react";
import { Img, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { C, ease, fontFamily, mono, pop, serif } from "./theme";

export const useT = () => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  return f / fps;
};

/** Fades and moves children in at `at`; optional fade-out at `out`. */
export const In: React.FC<{ t: number; at: number; out?: number; from?: "up" | "down" | "left" | "right" | "scale" | "none"; dist?: number; style?: React.CSSProperties; children: React.ReactNode }> = ({
  t,
  at,
  out,
  from = "up",
  dist = 40,
  style,
  children,
}) => {
  const p = pop(t, at, 0.6);
  const o = ease(t, at, 0.45) * (out === undefined ? 1 : 1 - ease(t, out, 0.35));
  const k = 1 - p;
  const tf =
    from === "up" ? `translateY(${k * dist}px)` : from === "down" ? `translateY(${-k * dist}px)` : from === "left" ? `translateX(${-k * dist}px)` : from === "right" ? `translateX(${k * dist}px)` : from === "scale" ? `scale(${0.85 + 0.15 * p})` : "none";
  return <div style={{ opacity: o, transform: tf, ...style }}>{children}</div>;
};

/** Serif headline whose words rise in one by one. Words wrapped in *stars* render italic and muted. */
export const Serif: React.FC<{ t: number; at: number; text: string; size: number; color?: string; gap?: number; align?: "left" | "center"; style?: React.CSSProperties }> = ({
  t,
  at,
  text,
  size,
  color = C.ink,
  gap = 0.07,
  align = "center",
  style,
}) => {
  let italic = false;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", justifyContent: align === "center" ? "center" : "flex-start", columnGap: size * 0.24, fontFamily: serif, fontSize: size, lineHeight: 1.04, letterSpacing: -size * 0.015, color, ...style }}>
      {text.split(" ").map((w, i) => {
        const starts = w.startsWith("*");
        if (starts) italic = true;
        const it = italic;
        if (w.endsWith("*")) italic = false;
        const p = pop(t, at + i * gap, 0.6);
        return (
          <span key={i} style={{ display: "inline-block", opacity: Math.min(1, p * 1.4), transform: `translateY(${(1 - p) * size * 0.45}px)`, fontStyle: it ? "italic" : "normal", color: it ? (color === "#fff" ? "#A8A8A8" : "#6B6B6B") : color }}>
            {w.replace(/\*/g, "")}
          </span>
        );
      })}
    </div>
  );
};

export const Pill: React.FC<{ children: React.ReactNode; tone?: "good" | "bad" | "warn" | "plain" | "ink" | "glass"; size?: number; style?: React.CSSProperties }> = ({ children, tone = "plain", size = 26, style }) => {
  const m = {
    good: [C.goodBg, C.good],
    bad: [C.badBg, C.bad],
    warn: [C.warnBg, C.warn],
    plain: [C.soft, C.ink],
    ink: [C.ink, "#fff"],
    glass: ["rgba(255,255,255,.85)", C.ink],
  }[tone];
  return (
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: size * 0.4,
        background: m[0],
        color: m[1],
        fontFamily,
        fontWeight: 500,
        fontSize: size,
        padding: `${size * 0.42}px ${size * 0.85}px`,
        borderRadius: 999,
        whiteSpace: "nowrap",
        boxShadow: tone === "glass" ? "0 10px 30px rgba(25,25,25,.08), inset 0 0 0 1px rgba(25,25,25,.06)" : "none",
        ...style,
      }}
    >
      {children}
    </div>
  );
};

export const Card: React.FC<{ children: React.ReactNode; style?: React.CSSProperties }> = ({ children, style }) => (
  <div style={{ background: "#fff", borderRadius: 32, boxShadow: "0 30px 80px rgba(25,25,25,.10), 0 0 0 1px rgba(25,25,25,.05)", ...style }}>{children}</div>
);

export const Logo: React.FC<{ size?: number; word?: boolean; color?: string }> = ({ size = 56, word = true, color = C.ink }) => (
  <div style={{ display: "flex", alignItems: "center", gap: size * 0.28 }}>
    <svg width={size} height={size} viewBox="0 0 32 32">
      <circle cx="13" cy="17" r="9" fill="none" stroke={color} strokeWidth="3" strokeDasharray="3.2 2.4" />
      <circle cx="13" cy="17" r="3.2" fill={color} />
      <path d="M19 4 L28 8 L22.5 12.5 Z" fill={C.bad} />
    </svg>
    {word && <span style={{ fontFamily, fontWeight: 600, fontSize: size * 0.82, letterSpacing: -size * 0.03, color }}>pawlr</span>}
  </div>
);

/** A captured screenshot inside a clean browser window, with a URL bar. */
export const Browser: React.FC<{ src: string; url: string; w: number; h: number; style?: React.CSSProperties; imgStyle?: React.CSSProperties; dark?: boolean; children?: React.ReactNode }> = ({ src, url, w, h, style, imgStyle, dark, children }) => (
  <div style={{ width: w, height: h, borderRadius: 26, overflow: "hidden", background: dark ? "#141414" : "#fff", boxShadow: "0 40px 100px rgba(25,25,25,.16), 0 0 0 1px rgba(25,25,25,.07)", position: "relative", ...style }}>
    <div style={{ height: 58, display: "flex", alignItems: "center", gap: 10, padding: "0 22px", background: dark ? "#1E1E1E" : "#F6F5F2", borderBottom: `1px solid ${dark ? "#2A2A2A" : C.line}` }}>
      {["#FF5F57", "#FEBC2E", "#28C840"].map((c) => (
        <div key={c} style={{ width: 14, height: 14, borderRadius: 7, background: c }} />
      ))}
      <div style={{ marginLeft: 18, flex: 1, height: 36, borderRadius: 18, background: dark ? "#2A2A2A" : "#fff", display: "flex", alignItems: "center", padding: "0 18px", fontFamily, fontSize: 19, color: dark ? "#BDBDBD" : C.muted, boxShadow: dark ? "none" : "inset 0 0 0 1px rgba(0,0,0,.06)" }}>
        🔒&nbsp;&nbsp;{url}
      </div>
    </div>
    <div style={{ position: "absolute", top: 58, left: 0, right: 0, bottom: 0, overflow: "hidden" }}>
      <Img src={staticFile(src)} style={{ width: "100%", display: "block", ...imgStyle }} />
      {children}
    </div>
  </div>
);

export const Shot: React.FC<{ src: string; w: number; style?: React.CSSProperties; radius?: number }> = ({ src, w, style, radius = 28 }) => (
  <div style={{ width: w, borderRadius: radius, overflow: "hidden", boxShadow: "0 30px 80px rgba(25,25,25,.12), 0 0 0 1px rgba(25,25,25,.05)", background: "#fff", ...style }}>
    <Img src={staticFile(src)} style={{ width: "100%", display: "block" }} />
  </div>
);

export const Check: React.FC<{ size?: number; color?: string }> = ({ size = 40, color = "#fff" }) => (
  <svg width={size} height={size} viewBox="0 0 24 24">
    <path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke={color} strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
export const Cross: React.FC<{ size?: number; color?: string }> = ({ size = 40, color = "#fff" }) => (
  <svg width={size} height={size} viewBox="0 0 24 24">
    <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" fill="none" stroke={color} strokeWidth={3} strokeLinecap="round" />
  </svg>
);

export const Label: React.FC<{ children: React.ReactNode; style?: React.CSSProperties }> = ({ children, style }) => (
  <div style={{ fontFamily, fontSize: 22, fontWeight: 600, letterSpacing: 3, textTransform: "uppercase", color: C.faint, ...style }}>{children}</div>
);

export const Mono: React.FC<{ children: React.ReactNode; style?: React.CSSProperties }> = ({ children, style }) => <span style={{ fontFamily: mono, ...style }}>{children}</span>;

/** Soft background with two slow-moving blurred blobs, like the landing page. */
export const Backdrop: React.FC<{ t: number; tint?: string }> = ({ t, tint = "#F2E9DF" }) => (
  <div style={{ position: "absolute", inset: 0, background: C.bg, overflow: "hidden" }}>
    <div style={{ position: "absolute", width: 900, height: 900, borderRadius: 450, background: tint, filter: "blur(140px)", opacity: 0.7, left: 1100 + Math.sin(t * 0.3) * 80, top: -300 + Math.cos(t * 0.25) * 60 }} />
    <div style={{ position: "absolute", width: 800, height: 800, borderRadius: 400, background: "#E6ECF5", filter: "blur(140px)", opacity: 0.7, left: -300 + Math.cos(t * 0.2) * 70, top: 500 + Math.sin(t * 0.3) * 50 }} />
  </div>
);
