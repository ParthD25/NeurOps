import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { loadFont } from "@remotion/google-fonts/PlusJakartaSans";
import { CHANGE_PCT, FIRST_3_WEEKS, LAST_3_WEEKS, WEEKLY_ERROR } from "./data.js";

// App Mockup style: soft blue-grey studio, one CSS-3D phone running Fireline,
// three floating cards that morph in one at a time. One accent: Fireline teal.
const { fontFamily } = loadFont("normal", { weights: ["500", "700", "800"], subsets: ["latin"] });

const C = {
  ink: "#0e1116",
  grey: "#7a818c",
  line: "#e6eaef",
  accent: "#1a9e8f",
  tint: "#e3f5f1",
  bar: "#d5dbe3",
};

const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" };
const tab = { fontVariantNumeric: "tabular-nums" };

// ~10% overshoot entrance spring, starting at `at` frames.
function useSpring(at, config = { damping: 13, stiffness: 170, mass: 0.9 }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return spring({ frame: frame - at, fps, config });
}

const LAYOUTS = {
  wide: {
    phone: { x: 860, y: 548, scale: 1.0 },
    notif: { x: 300, y: 128, w: 450 },
    stat: { x: 1150, y: 360, w: 340 },
    ring: { x: 410, y: 742, w: 380 },
  },
  tall: {
    phone: { x: 470, y: 860, scale: 1.12 },
    notif: { x: 96, y: 260, w: 470 },
    stat: { x: 664, y: 760, w: 300 },
    ring: { x: 96, y: 1250, w: 400 },
  },
};

const PHONE_W = 380;
const PHONE_H = 790;

export const Hero = ({ layout = "wide" }) => {
  const frame = useCurrentFrame();
  const L = LAYOUTS[layout];

  // Phone swings from steeply turned to a three-quarter view on a heavy spring.
  const swing = useSpring(0, { damping: 15, stiffness: 70, mass: 1.5 });
  const rx = interpolate(swing, [0, 1], [30, 14]);
  const ry = interpolate(swing, [0, 1], [-48, -20]);
  const rz = interpolate(swing, [0, 1], [9, 3]);
  const lift = interpolate(swing, [0, 1], [60, 0]);

  // Slow parallax float after the build.
  const float = (depth) => {
    const t = Math.max(0, frame - 95) / 30;
    const k = interpolate(frame, [95, 115], [0, 1], clamp);
    return { x: Math.sin(t * 1.1 + depth) * 6 * depth * k, y: Math.sin(t * 1.4 + depth * 2) * 7 * depth * k };
  };
  const pf = float(0.6);

  return (
    <AbsoluteFill style={{ fontFamily, color: C.ink }}>
      <Backdrop L={L} />
      {/* floor shadow widens as the phone faces the camera */}
      <div
        style={{
          position: "absolute",
          left: L.phone.x - 240 * L.phone.scale,
          top: L.phone.y + (PHONE_H / 2) * L.phone.scale - 10,
          width: 480 * L.phone.scale,
          height: 70,
          borderRadius: "50%",
          background: "radial-gradient(closest-side, rgba(20,30,45,0.32), rgba(20,30,45,0))",
          transform: `scaleX(${interpolate(swing, [0, 1], [0.45, 1])})`,
          filter: "blur(6px)",
        }}
      />
      <div
        style={{
          position: "absolute",
          left: L.phone.x + pf.x,
          top: L.phone.y + lift + pf.y,
          perspective: 1800,
          transform: `translate(-50%, -50%) scale(${L.phone.scale})`,
        }}
      >
        <div
          style={{
            width: PHONE_W,
            height: PHONE_H,
            transformStyle: "preserve-3d",
            transform: `rotateX(${rx}deg) rotateY(${ry}deg) rotateZ(${rz}deg)`,
          }}
        >
          <PhoneBody swing={swing} />
        </div>
      </div>
      <NotificationCard L={L} />
      <StatCard L={L} />
      <RingCard L={L} />
      <Grain />
    </AbsoluteFill>
  );
};

const Backdrop = ({ L }) => (
  <AbsoluteFill
    style={{
      background: `radial-gradient(ellipse 60% 55% at ${(L.phone.x / (L === LAYOUTS.wide ? 1920 : 1080)) * 100}% 48%, #f4f7fa 0%, #dfe6ee 55%, #cfd8e2 100%)`,
    }}
  />
);

// Fine static grain so the backdrop gradient never bands.
const Grain = () => (
  <AbsoluteFill style={{ opacity: 0.07, mixBlendMode: "multiply", pointerEvents: "none" }}>
    <svg width="100%" height="100%">
      <filter id="grain">
        <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" stitchTiles="stitch" />
        <feColorMatrix type="saturate" values="0" />
      </filter>
      <rect width="100%" height="100%" filter="url(#grain)" />
    </svg>
  </AbsoluteFill>
);

const PhoneBody = ({ swing }) => {
  // A glint runs along the metal edge mid-turn.
  const glint = interpolate(swing, [0.25, 0.95], [-40, 140], clamp);
  const layers = [12, 9, 6, 3];
  return (
    <>
      {layers.map((z) => (
        <div
          key={z}
          style={{
            position: "absolute",
            inset: 0,
            borderRadius: 60,
            transform: `translateZ(${-z}px)`,
            background: "linear-gradient(135deg, #8d949e, #c8cdd4 45%, #7c838d)",
          }}
        />
      ))}
      <div
        style={{
          position: "absolute",
          inset: 0,
          borderRadius: 60,
          background: `linear-gradient(115deg, #aab0b8 ${glint - 30}%, #ffffff ${glint}%, #aab0b8 ${glint + 30}%)`,
          boxShadow: "0 40px 80px -30px rgba(15,25,40,0.45)",
        }}
      />
      <div
        style={{
          position: "absolute",
          inset: 9,
          borderRadius: 52,
          background: "#0b0d10",
          padding: 7,
        }}
      >
        <Screen />
        {/* faint light band on the glass */}
        <div
          style={{
            position: "absolute",
            inset: 7,
            borderRadius: 46,
            background: "linear-gradient(120deg, rgba(255,255,255,0) 35%, rgba(255,255,255,0.16) 48%, rgba(255,255,255,0) 60%)",
            pointerEvents: "none",
          }}
        />
      </div>
    </>
  );
};

const Screen = () => {
  const frame = useCurrentFrame();
  const count = interpolate(frame, [18, 50], [FIRST_3_WEEKS, LAST_3_WEEKS], { ...clamp, easing: (t) => 1 - (1 - t) ** 3 });
  const chip = useSpring(50);
  const pill = useSpring(14, { damping: 16, stiffness: 200 });
  return (
    <div
      style={{
        position: "relative",
        width: "100%",
        height: "100%",
        borderRadius: 46,
        background: "#ffffff",
        overflow: "hidden",
        padding: "16px 22px 0",
      }}
    >
      {/* status bar + camera pill */}
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, fontWeight: 700, padding: "2px 8px 0", ...tab }}>
        <span>7:42</span>
        <span style={{ color: C.grey }}>●●● 5G</span>
      </div>
      <div style={{ position: "absolute", top: 12, left: "50%", width: 96, height: 28, marginLeft: -48, borderRadius: 20, background: "#0b0d10" }} />

      <div style={{ marginTop: 26, fontSize: 13, color: C.grey, fontWeight: 500 }}>Friday rush · expo</div>
      <div style={{ fontSize: 20, fontWeight: 800, letterSpacing: "-0.01em" }}>Fireline</div>

      <div style={{ marginTop: 18, fontSize: 12.5, color: C.grey, fontWeight: 500 }}>Prep-time forecast error</div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 2 }}>
        <span style={{ fontSize: 46, fontWeight: 800, letterSpacing: "-0.03em", lineHeight: 1.05, ...tab }}>
          {count.toFixed(1)}
          <span style={{ fontSize: 28 }}>s</span>
        </span>
        <span
          style={{
            transform: `scale(${chip})`,
            transformOrigin: "left center",
            background: C.tint,
            color: C.accent,
            fontWeight: 800,
            fontSize: 13,
            borderRadius: 99,
            padding: "5px 10px",
            ...tab,
          }}
        >
          ▼ {Math.abs(CHANGE_PCT)}%
        </span>
      </div>

      <Chart />

      {/* tab selector: pill slides to "9 weeks" */}
      <div style={{ position: "relative", display: "flex", background: "#f1f4f7", borderRadius: 12, padding: 4, marginTop: 10, fontSize: 12.5, fontWeight: 700 }}>
        <div
          style={{
            position: "absolute",
            top: 4,
            bottom: 4,
            width: "calc((100% - 8px) / 3)",
            left: `calc(4px + ${interpolate(pill, [0, 1], [0, 2])} * (100% - 8px) / 3)`,
            background: "#fff",
            borderRadius: 9,
            boxShadow: "0 1px 3px rgba(15,25,40,0.15)",
          }}
        />
        {["Today", "Week", "9 weeks"].map((label) => (
          <span key={label} style={{ position: "relative", flex: 1, textAlign: "center", padding: "7px 0", color: label === "9 weeks" ? C.ink : C.grey }}>
            {label}
          </span>
        ))}
      </div>

      <div style={{ marginTop: 12 }}>
        <Row at={30} id="T-014" where="Table 03" state="In kitchen" dot={C.accent} />
        <Row at={36} id="T-012" where="Pickup" state="Fire in 2m" dot="#e4572e" />
        <Row at={42} id="T-009" where="Delivery" state="Ready" dot="#6e74db" />
        <Row at={48} id="T-007" where="Table 05" state="Served" dot={C.grey} />
      </div>

      <TabBar />
    </div>
  );
};

const Chart = () => {
  const frame = useCurrentFrame();
  const W = 324;
  const H = 120;
  const max = 34;
  const min = 18;
  const pts = WEEKLY_ERROR.map((v, i) => [8 + (i / (WEEKLY_ERROR.length - 1)) * (W - 16), 10 + (1 - (v - min) / (max - min)) * (H - 24)]);
  const p = interpolate(frame, [18, 50], [0, 1], { ...clamp, easing: (t) => 1 - (1 - t) ** 2 });
  // Position along the polyline at progress p.
  const segs = pts.slice(1).map((pt, i) => Math.hypot(pt[0] - pts[i][0], pt[1] - pts[i][1]));
  const total = segs.reduce((a, b) => a + b, 0);
  let left = p * total;
  let tip = pts[0];
  let tipValue = WEEKLY_ERROR[0];
  for (let i = 0; i < segs.length; i += 1) {
    if (left <= segs[i]) {
      const f = segs[i] ? left / segs[i] : 0;
      tip = [pts[i][0] + (pts[i + 1][0] - pts[i][0]) * f, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * f];
      tipValue = WEEKLY_ERROR[i] + (WEEKLY_ERROR[i + 1] - WEEKLY_ERROR[i]) * f;
      break;
    }
    left -= segs[i];
    tip = pts[i + 1];
    tipValue = WEEKLY_ERROR[i + 1];
  }
  const d = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join("");
  return (
    <div style={{ position: "relative", marginTop: 6 }}>
      <svg width={W} height={H} style={{ display: "block", overflow: "visible" }}>
        <path d={`${d}L${pts.at(-1)[0]},${H}L${pts[0][0]},${H}Z`} fill={C.tint} opacity={0.6} style={{ clipPath: `inset(0 ${(1 - p) * 100}% 0 0)` }} />
        <path d={d} fill="none" stroke={C.accent} strokeWidth={2.6} strokeLinejoin="round" strokeLinecap="round" strokeDasharray={total} strokeDashoffset={(1 - p) * total} />
        <circle cx={tip[0]} cy={tip[1]} r={5} fill={C.accent} stroke="#fff" strokeWidth={2.5} />
      </svg>
      <div
        style={{
          position: "absolute",
          left: Math.min(W - 58, tip[0] - 26),
          top: tip[1] - 34,
          background: C.ink,
          color: "#fff",
          fontSize: 11.5,
          fontWeight: 700,
          borderRadius: 7,
          padding: "3px 7px",
          ...tab,
        }}
      >
        {tipValue.toFixed(1)}s
      </div>
    </div>
  );
};

// Rows rise from behind their own edges.
const Row = ({ at, id, where, state, dot }) => {
  const s = useSpring(at);
  return (
    <div style={{ overflow: "hidden" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "9px 2px",
          borderBottom: `1px solid ${C.line}`,
          transform: `translateY(${interpolate(s, [0, 1], [44, 0])}px)`,
        }}
      >
        <span style={{ width: 30, height: 30, borderRadius: 9, background: "#f1f4f7", display: "grid", placeItems: "center" }}>
          <span style={{ width: 9, height: 9, borderRadius: 9, background: dot }} />
        </span>
        <span style={{ flex: 1 }}>
          <span style={{ display: "block", fontSize: 13.5, fontWeight: 700, ...tab }}>Order #{id}</span>
          <span style={{ display: "block", fontSize: 11.5, color: C.grey, fontWeight: 500 }}>{where}</span>
        </span>
        <span style={{ fontSize: 12, fontWeight: 700, color: C.ink }}>{state}</span>
      </div>
    </div>
  );
};

const TabBar = () => (
  <div
    style={{
      position: "absolute",
      left: 0,
      right: 0,
      bottom: 0,
      height: 64,
      borderTop: `1px solid ${C.line}`,
      display: "flex",
      justifyContent: "space-around",
      alignItems: "center",
      fontSize: 10.5,
      fontWeight: 700,
      color: C.grey,
      background: "#fff",
    }}
  >
    {["Orders", "Tables", "Model", "Presets"].map((label, i) => (
      <span key={label} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4, color: i === 0 ? C.accent : C.grey }}>
        <span style={{ width: 20, height: 20, borderRadius: 6, border: `2px solid currentColor` }} />
        {label}
      </span>
    ))}
  </div>
);

const cardShadow = "0 1px 2px rgba(15,25,40,0.06), 0 10px 24px -8px rgba(15,25,40,0.18), 0 30px 60px -24px rgba(15,25,40,0.28)";

// 1. Notification pops out of the camera pill and unfolds.
const NotificationCard = ({ L }) => {
  const s = useSpring(56);
  const k = Math.min(1, Math.max(0, s));
  const pf = (() => {
    const frame = useCurrentFrame();
    const t = Math.max(0, frame - 95) / 30;
    const kk = interpolate(frame, [95, 115], [0, 1], clamp);
    return { x: Math.sin(t * 1.1 + 1.4) * 12 * kk, y: Math.sin(t * 1.3 + 2) * 10 * kk };
  })();
  // Starts as the phone's camera pill (near the phone top), grows into the card.
  const fromX = L.phone.x - 48;
  const fromY = L.phone.y - (PHONE_H / 2) * L.phone.scale + 30;
  const x = interpolate(s, [0, 1], [fromX, L.notif.x]);
  const y = interpolate(s, [0, 1], [fromY, L.notif.y]);
  const w = interpolate(s, [0, 1], [96, L.notif.w]);
  const h = interpolate(s, [0, 1], [28, 104]);
  if (s <= 0.001) return null;
  return (
    <div
      style={{
        position: "absolute",
        left: x + pf.x,
        top: y + pf.y,
        width: w,
        height: h,
        borderRadius: interpolate(k, [0, 1], [20, 24]),
        background: "#0b0d10",
        overflow: "hidden",
        boxShadow: cardShadow,
      }}
    >
      {/* white floods outward from inside the pill: colour change by geometry */}
      <div style={{ position: "absolute", inset: 0, background: "#fff", borderRadius: "inherit", transform: `scale(${interpolate(k, [0.15, 0.6], [0, 1.05], clamp)})` }} />
      <div
        style={{
          position: "relative",
          display: "flex",
          gap: 14,
          alignItems: "center",
          padding: "18px 20px",
          opacity: k > 0.55 ? 1 : 0,
          transform: `translateY(${interpolate(k, [0.55, 1], [14, 0], clamp)}px)`,
          width: L.notif.w,
        }}
      >
        <span style={{ width: 54, height: 54, borderRadius: 15, background: C.accent, display: "grid", placeItems: "center", flex: "none" }}>
          <svg width="26" height="26" viewBox="0 0 32 32">
            <path d="M16 4c1.2 4.6 7 7 7 13.6a7 7 0 0 1-14 0c0-3.4 2.3-4.7 2.3-8 2.3 1.2 3.5 3.4 3.5 5.7 1.2-3.4 1.2-6.9 1.2-11.3z" fill="#fff" />
          </svg>
        </span>
        <span>
          <span style={{ display: "block", fontSize: 21, fontWeight: 800, letterSpacing: "-0.01em" }}>Fire Steak Plate now</span>
          <span style={{ display: "block", fontSize: 16, color: C.grey, fontWeight: 500, marginTop: 2 }}>Lands with the fries · Table 03</span>
        </span>
      </div>
    </div>
  );
};

// 2. Stat card grows out of its percentage chip, then the bars spring up.
const StatCard = ({ L }) => {
  const frame = useCurrentFrame();
  const s = useSpring(71);
  if (s <= 0.001) return null;
  const t = Math.max(0, frame - 95) / 30;
  const kk = interpolate(frame, [95, 115], [0, 1], clamp);
  const fx = Math.sin(t * 1.2 + 3) * 16 * kk;
  const fy = Math.sin(t * 1.5 + 1) * 13 * kk;
  const chipW = 92;
  const chipH = 34;
  const w = interpolate(s, [0, 1], [chipW, L.stat.w]);
  const h = interpolate(s, [0, 1], [chipH, 224]);
  const k = Math.min(1, Math.max(0, s));
  const maxV = Math.max(...WEEKLY_ERROR);
  return (
    <div
      style={{
        position: "absolute",
        left: L.stat.x + fx,
        top: L.stat.y + fy,
        width: w,
        height: h,
        borderRadius: interpolate(k, [0, 1], [99, 24]),
        background: interpolate(k, [0, 0.4], [0, 1], clamp) < 1 ? C.tint : "#fff",
        boxShadow: cardShadow,
        overflow: "hidden",
        padding: interpolate(k, [0, 1], [6, 20]),
      }}
    >
      {k < 0.4 ? (
        <span style={{ display: "block", textAlign: "center", color: C.accent, fontWeight: 800, fontSize: 16, ...tab }}>▼ {Math.abs(CHANGE_PCT)}%</span>
      ) : (
        <>
          <div style={{ fontSize: 15, color: C.grey, fontWeight: 700 }}>Prep error by week</div>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginTop: 2 }}>
            <span style={{ fontSize: 30, fontWeight: 800, letterSpacing: "-0.02em", ...tab }}>{LAST_3_WEEKS}s</span>
            <span style={{ fontSize: 14, fontWeight: 700, color: C.accent, ...tab }}>from {FIRST_3_WEEKS}s</span>
          </div>
          <div style={{ display: "flex", alignItems: "flex-end", gap: 9, height: 96, marginTop: 10 }}>
            {WEEKLY_ERROR.map((v, i) => {
              const last = i === WEEKLY_ERROR.length - 1;
              // accent bar last
              const b = spring({ frame: frame - (80 + (last ? 14 : i * 1.5)), fps: 30, config: { damping: 12, stiffness: 180 } });
              return <span key={i} style={{ flex: 1, height: `${(v / maxV) * 100 * Math.max(0, b)}%`, borderRadius: 5, background: last ? C.accent : C.bar }} />;
            })}
          </div>
        </>
      )}
    </div>
  );
};

// 3. Progress card starts as a white disc, stretches into the card while the ring sweeps.
const RingCard = ({ L }) => {
  const frame = useCurrentFrame();
  const s = useSpring(86);
  if (s <= 0.001) return null;
  const k = Math.min(1, Math.max(0, s));
  const t = Math.max(0, frame - 95) / 30;
  const kk = interpolate(frame, [95, 115], [0, 1], clamp);
  const fx = Math.sin(t * 1 + 5) * 10 * kk;
  const fy = Math.sin(t * 1.25 + 4) * 9 * kk;
  const w = interpolate(s, [0, 1], [72, L.ring.w]);
  const sweep = interpolate(frame, [88, 118], [0, 1], { ...clamp, easing: (x) => 1 - (1 - x) ** 3 });
  const r = 24;
  const circ = 2 * Math.PI * r;
  return (
    <div
      style={{
        position: "absolute",
        left: L.ring.x + fx,
        top: L.ring.y + fy,
        width: w,
        height: 92 + 20 * k,
        borderRadius: interpolate(k, [0, 1], [56, 24]),
        background: "#fff",
        boxShadow: cardShadow,
        overflow: "hidden",
        display: "flex",
        alignItems: "center",
        gap: 16,
        padding: "0 20px",
      }}
    >
      <svg width="60" height="60" viewBox="0 0 60 60" style={{ flex: "none" }}>
        <circle cx="30" cy="30" r={r} fill="none" stroke={C.line} strokeWidth="7" />
        <circle cx="30" cy="30" r={r} fill="none" stroke={C.accent} strokeWidth="7" strokeLinecap="round" strokeDasharray={circ} strokeDashoffset={circ * (1 - sweep)} transform="rotate(-90 30 30)" />
      </svg>
      <span style={{ whiteSpace: "nowrap", opacity: k > 0.6 ? 1 : 0, transform: `translateY(${interpolate(k, [0.6, 1], [12, 0], clamp)}px)` }}>
        <span style={{ display: "block", fontSize: 20, fontWeight: 800 }}>Model v3 live</span>
        <span style={{ display: "block", fontSize: 15, color: C.grey, fontWeight: 500, ...tab }}>
          Retrains every 3 weeks · {Math.round(sweep * 21)}/21 days
        </span>
      </span>
    </div>
  );
};
