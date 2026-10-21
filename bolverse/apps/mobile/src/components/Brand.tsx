import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Animated, Easing, Image, Modal, Platform, Pressable, SectionList, StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Svg, { Circle, Defs, LinearGradient, Path, RadialGradient, Rect, Stop } from "react-native-svg";
import { LANGUAGES, REGIONS, findLang, palette, type Palette } from "@bolverse/shared";
import { fonts, radius, useColors } from "../lib/theme";

let gradSeq = 0;
const useGradId = () => useRef(`g${++gradSeq}`).current;

export type GradName = "you" | "them" | "aurora";
/** Gradient stops, taken from the app icon. */
export function gradStops(c: Palette, name: GradName): string[] {
  if (name === "them") return ["#7EEBFF", c.them, "#22B8E6"];
  if (name === "aurora") return [c.gradA, c.gradB, c.gradC, c.gradD];
  return [c.gradB, "#6A3BFF", "#8E2FF0"];
}

/** Fills its parent with a diagonal gradient. Put it first inside a View with overflow hidden. */
export function GradFill({ name = "you", radius: r = 0 }: { name?: GradName; radius?: number }) {
  const c = useColors();
  const id = useGradId();
  const stops = gradStops(c, name);
  return (
    <Svg style={StyleSheet.absoluteFill} width="100%" height="100%" pointerEvents="none">
      <Defs>
        <LinearGradient id={id} x1="0" y1="0" x2="1" y2="1">
          {stops.map((col, i) => <Stop key={i} offset={i / (stops.length - 1)} stopColor={col} />)}
        </LinearGradient>
      </Defs>
      <Rect x="0" y="0" width="100%" height="100%" rx={r} ry={r} fill={`url(#${id})`} />
    </Svg>
  );
}

/** A View with a gradient background. */
export function GradView({ name = "you", style, children }: { name?: GradName; style?: StyleProp<ViewStyle>; children?: ReactNode }) {
  return (
    <View style={[{ overflow: "hidden" }, style]}>
      <GradFill name={name} />
      {/* On the web an absolutely placed layer paints over plain siblings, so lift the content there. */}
      {Platform.OS === "web" ? <View>{children}</View> : children}
    </View>
  );
}

/** Soft aurora glow behind every screen. */
export function Aurora() {
  const c = useColors();
  const dark = c.bg === palette.dark.bg;
  const a = dark ? 0.32 : 0.18;
  return (
    <Svg style={StyleSheet.absoluteFill} width="100%" height="100%" pointerEvents="none">
      <Defs>
        <RadialGradient id="au1" cx="0%" cy="0%" r="70%"><Stop offset="0" stopColor={c.gradB} stopOpacity={a} /><Stop offset="1" stopColor={c.gradB} stopOpacity={0} /></RadialGradient>
        <RadialGradient id="au2" cx="100%" cy="8%" r="60%"><Stop offset="0" stopColor={c.gradD} stopOpacity={a * 0.75} /><Stop offset="1" stopColor={c.gradD} stopOpacity={0} /></RadialGradient>
        <RadialGradient id="au3" cx="50%" cy="105%" r="70%"><Stop offset="0" stopColor={c.gradA} stopOpacity={a * 0.8} /><Stop offset="1" stopColor={c.gradA} stopOpacity={0} /></RadialGradient>
      </Defs>
      <Rect width="100%" height="100%" fill="url(#au1)" />
      <Rect width="100%" height="100%" fill="url(#au2)" />
      <Rect width="100%" height="100%" fill="url(#au3)" />
    </Svg>
  );
}

const LOGO = require("../../assets/splash-icon.png");

/** The Bolverse app icon. */
export function Logo({ size = 30 }: { size?: number }) {
  return <Image source={LOGO} style={{ width: size, height: size }} accessibilityIgnoresInvertColors />;
}

/** Bolverse's AI face: a glowing aurora orb with a sparkle, and a spinning ring while it's thinking. */
export function BotAvatar({ size = 36, thinking = false }: { size?: number; thinking?: boolean }) {
  const c = useColors();
  const id = useGradId();
  const spin = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!thinking) { spin.stopAnimation(); spin.setValue(0); return; }
    const loop = Animated.loop(Animated.timing(spin, { toValue: 1, duration: 900, easing: Easing.linear, useNativeDriver: true }));
    loop.start();
    return () => loop.stop();
  }, [thinking]);
  const rotate = spin.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "360deg"] });
  return (
    <View style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {thinking && (
        <Animated.View style={{ position: "absolute", width: size + 10, height: size + 10, borderRadius: (size + 10) / 2, borderWidth: 2.5,
          borderColor: "transparent", borderTopColor: c.you, borderRightColor: c.them, transform: [{ rotate }] }} />
      )}
      <Svg width={size} height={size} viewBox="0 0 40 40">
        <Defs>
          <LinearGradient id={id} x1="0" y1="0" x2="1" y2="1">
            <Stop offset="0" stopColor={c.gradA} /><Stop offset="0.38" stopColor={c.gradB} />
            <Stop offset="0.72" stopColor={c.gradC} /><Stop offset="1" stopColor={c.gradD} />
          </LinearGradient>
          <RadialGradient id={id + "h"} cx="32%" cy="26%" r="45%">
            <Stop offset="0" stopColor="#fff" stopOpacity={0.55} /><Stop offset="1" stopColor="#fff" stopOpacity={0} />
          </RadialGradient>
        </Defs>
        <Circle cx="20" cy="20" r="20" fill={`url(#${id})`} />
        <Circle cx="20" cy="20" r="20" fill={`url(#${id}h)`} />
        <Path d="M20 9.5l2.6 7.6 7.6 2.6-7.6 2.6L20 29.9l-2.6-7.6-7.6-2.6 7.6-2.6z" fill="#fff" />
        <Path d="M28.6 25.4l1 2.8 2.8 1-2.8 1-1 2.8-1-2.8-2.8-1 2.8-1z" fill="#fff" opacity={0.85} />
      </Svg>
    </View>
  );
}

/** Small gradient "AI" tag used next to AI-powered features. */
export function AiTag({ label = "AI" }: { label?: string }) {
  return (
    <GradView name="aurora" style={{ borderRadius: 999, paddingHorizontal: 7, paddingVertical: 1 }}>
      <Text style={{ color: "#fff", fontSize: 11, fontWeight: "800", letterSpacing: 0.6 }}>{label}</Text>
    </GradView>
  );
}

export function Wordmark() {
  const c = useColors();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      <Logo size={32} />
      <Text style={{ fontFamily: fonts.display, fontSize: 22, color: c.ink, letterSpacing: -0.6 }}>Bolverse</Text>
      <AiTag />
    </View>
  );
}

export function TopBar({ right }: { right?: ReactNode }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 20, paddingTop: 10, paddingBottom: 6 }}>
      <Wordmark />{right}
    </View>
  );
}

/* ---------- Buttons ---------- */

type Kind = "primary" | "ink" | "ghost" | "onPrimary";

export function Btn({ label, onPress, kind = "ink", icon, disabled, big, style }: {
  label: string; onPress: () => void; kind?: Kind; icon?: ReactNode; disabled?: boolean; big?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const c = useColors();
  const bg = { primary: c.you, ink: c.ink, ghost: c.surface, onPrimary: "#FFFFFF" }[kind];
  const fg = { primary: "#FFFFFF", ink: c.bg, ghost: c.ink, onPrimary: c.accent }[kind];
  const r = big ? 18 : radius.control;
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} disabled={disabled}
      style={({ pressed }) => [{
        backgroundColor: bg, borderRadius: r, paddingVertical: big ? 16 : 11,
        paddingHorizontal: big ? 24 : 16, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8,
        borderWidth: kind === "ghost" ? 1.5 : 0, borderColor: c.line, opacity: disabled ? 0.5 : 1,
        alignSelf: "flex-start", overflow: "hidden", transform: [{ scale: pressed && !disabled ? 0.97 : 1 }],
      }, kind === "primary" && !disabled && shadow(c.you), style]}>
      {kind === "primary" && <GradFill name="you" />}
      {icon ? <View>{icon}</View> : null}
      <Text style={{ color: fg, fontWeight: "700", fontSize: big ? 17 : 15 }}>{label}</Text>
    </Pressable>
  );
}

/**
 * Soft coloured glow under gradient shapes. The solid background matters on Android: elevation shadows
 * follow the background's rounded shape; without one they come out as square boxes.
 */
export function shadow(color: string): ViewStyle {
  return { backgroundColor: color, shadowColor: color, shadowOpacity: 0.3, shadowRadius: 12, shadowOffset: { width: 0, height: 6 }, elevation: 4 };
}

/** Live microphone level: five bars that grow with the voice, so people can see they're being heard. */
export function LevelBars({ level, color }: { level: number; color: string }) {
  const weights = [0.55, 0.8, 1, 0.8, 0.55];
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 3, height: 22 }} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {weights.map((w, i) => (
        <View key={i} style={{ width: 4, borderRadius: 2, backgroundColor: color, height: 4 + Math.round(18 * Math.min(1, level * w * 1.2)) }} />
      ))}
    </View>
  );
}

/* ---------- Language picker (modal list; React Native has no <select>) ---------- */

export function LangPicker({ value, onChange, exclude, label, children, style }: {
  value: string; onChange: (code: string) => void; exclude?: string; label: string;
  children?: ReactNode; style?: StyleProp<ViewStyle>;
}) {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const [open, setOpen] = useState(false);
  const s = useMemo(() => pickerStyles(c), [c]);
  const current = findLang(value);
  const items = LANGUAGES.filter((l) => l.code !== exclude);
  return (
    <>
      <Pressable accessibilityRole="button" accessibilityLabel={`${label}: ${current.name}`} onPress={() => setOpen(true)} style={style}>
        {children ?? (
          <View style={s.trigger}>
            <Text style={s.triggerText}>{current.name} ({current.native})</Text>
            <Text style={{ color: c.muted }}>▾</Text>
          </View>
        )}
      </Pressable>
      <Modal visible={open} animationType="slide" transparent onRequestClose={() => setOpen(false)}>
        <Pressable style={s.backdrop} onPress={() => setOpen(false)} accessibilityLabel="Close" />
        <View style={[s.sheet, { paddingBottom: insets.bottom + 8 }]}>
          <Text style={s.title}>{label}</Text>
          <SectionList sections={REGIONS.map((r) => ({ title: r, data: items.filter((l) => l.region === r) }))}
            keyExtractor={(l) => l.code} initialNumToRender={30} stickySectionHeadersEnabled
            renderSectionHeader={({ section }) => <Text style={s.section}>{section.title}</Text>}
            renderItem={({ item }) => {
              const selected = item.code === value;
              return (
                <Pressable accessibilityRole="button" accessibilityState={{ selected }}
                  onPress={() => { onChange(item.code); setOpen(false); }}
                  style={[s.row, selected && { backgroundColor: c.youSoft }]}>
                  <Text style={s.native}>{item.native}</Text>
                  <Text style={s.name}>{item.name}</Text>
                </Pressable>
              );
            }} />
        </View>
      </Modal>
    </>
  );
}

const pickerStyles = (c: Palette) => StyleSheet.create({
  trigger: { borderWidth: 1.5, borderColor: c.line, backgroundColor: c.surface, borderRadius: 16, paddingVertical: 12, paddingHorizontal: 14, flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  triggerText: { color: c.ink, fontSize: 16 },
  backdrop: { flex: 1, backgroundColor: "rgba(11,9,32,0.5)" },
  sheet: { maxHeight: "75%", backgroundColor: c.surface, borderTopLeftRadius: 28, borderTopRightRadius: 28, paddingTop: 18 },
  title: { fontFamily: fonts.displayBold, fontSize: 20, color: c.ink, paddingHorizontal: 20, marginBottom: 8 },
  section: { backgroundColor: c.surface, color: c.muted, fontSize: 13, fontWeight: "700", paddingHorizontal: 20, paddingTop: 12, paddingBottom: 4 },
  row: { paddingVertical: 12, paddingHorizontal: 20, flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  native: { color: c.ink, fontSize: 18, fontWeight: "600" },
  name: { color: c.muted, fontSize: 14 },
});

/* ---------- Icons ---------- */

type IconProps = { color: string; size?: number };
const stroke = (color: string) => ({ stroke: color, strokeWidth: 2, fill: "none", strokeLinecap: "round" as const, strokeLinejoin: "round" as const });

export const Icons = {
  Mic: ({ color, size = 28 }: IconProps) => (
    <Svg width={size} height={size} viewBox="0 0 24 24"><Rect x="9" y="3" width="6" height="11" rx="3" {...stroke(color)} /><Path d="M5 11a7 7 0 0 0 14 0M12 18v3" {...stroke(color)} /></Svg>
  ),
  Stop: ({ color, size = 28 }: IconProps) => (
    <Svg width={size} height={size} viewBox="0 0 24 24"><Rect x="6" y="6" width="12" height="12" rx="2" fill={color} /></Svg>
  ),
  Speaker: ({ color, size = 20 }: IconProps) => (
    <Svg width={size} height={size} viewBox="0 0 24 24"><Path d="M4 9v6h4l5 4V5L8 9z" {...stroke(color)} /><Path d="M16 9a4 4 0 0 1 0 6M19 6a8 8 0 0 1 0 12" {...stroke(color)} /></Svg>
  ),
  Swap: ({ color, size = 22 }: IconProps) => (
    <Svg width={size} height={size} viewBox="0 0 24 24"><Path d="M7 7h12l-3-3M17 17H5l3 3" {...stroke(color)} /></Svg>
  ),
  Chat: ({ color, size = 24 }: IconProps) => (
    <Svg width={size} height={size} viewBox="0 0 24 24"><Path d="M4 5h11v8H8l-4 3z" {...stroke(color)} /><Path d="M15 9h5v8l-3-2h-6v-2" {...stroke(color)} /></Svg>
  ),
  Book: ({ color, size = 24 }: IconProps) => (
    <Svg width={size} height={size} viewBox="0 0 24 24"><Path d="M4 5c3-1 6-1 8 1 2-2 5-2 8-1v14c-3-1-6-1-8 1-2-2-5-2-8-1z" {...stroke(color)} /><Path d="M12 6v14" {...stroke(color)} /></Svg>
  ),
  User: ({ color, size = 24 }: IconProps) => (
    <Svg width={size} height={size} viewBox="0 0 24 24"><Circle cx="12" cy="8" r="4" {...stroke(color)} /><Path d="M4 21c1-4 4-6 8-6s7 2 8 6" {...stroke(color)} /></Svg>
  ),
  Back: ({ color, size = 18 }: IconProps) => (
    <Svg width={size} height={size} viewBox="0 0 24 24"><Path d="M15 5l-7 7 7 7" {...stroke(color)} /></Svg>
  ),
  Play: ({ color, size = 18 }: IconProps) => (
    <Svg width={size} height={size} viewBox="0 0 24 24"><Path d="M7 4l13 8-13 8z" fill={color} /></Svg>
  ),
  Lock: ({ color, size = 16 }: IconProps) => (
    <Svg width={size} height={size} viewBox="0 0 24 24"><Rect x="5" y="11" width="14" height="10" rx="2" {...stroke(color)} /><Path d="M8 11V8a4 4 0 0 1 8 0v3" {...stroke(color)} /></Svg>
  ),
  Sparkle: ({ color, size = 24 }: IconProps) => (
    <Svg width={size} height={size} viewBox="0 0 24 24"><Path d="M12 3l2 5 5 2-5 2-2 5-2-5-5-2 5-2zM19 15l1 2 2 1-2 1-1 2-1-2-2-1 2-1z" {...stroke(color)} /></Svg>
  ),
  History: ({ color, size = 24 }: IconProps) => (
    <Svg width={size} height={size} viewBox="0 0 24 24"><Path d="M3 12a9 9 0 1 0 3-6.7L3 8" {...stroke(color)} /><Path d="M3 3v5h5M12 7v5l3 2" {...stroke(color)} /></Svg>
  ),
  Send: ({ color, size = 20 }: IconProps) => (
    <Svg width={size} height={size} viewBox="0 0 24 24"><Path d="M4 12l16-8-6 16-2-7z" {...stroke(color)} /></Svg>
  ),
  Copy: ({ color, size = 18 }: IconProps) => (
    <Svg width={size} height={size} viewBox="0 0 24 24"><Rect x="8" y="8" width="12" height="12" rx="2" {...stroke(color)} /><Path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" {...stroke(color)} /></Svg>
  ),
  Slow: ({ color, size = 18 }: IconProps) => (
    <Svg width={size} height={size} viewBox="0 0 24 24"><Path d="M3 15c0-4 3-7 7-7s7 3 7 7H3zM17 13h2a2 2 0 0 0 2-2M6 15v2M14 15v2" {...stroke(color)} /></Svg>
  ),
  Qr: ({ color, size = 24 }: IconProps) => (
    <Svg width={size} height={size} viewBox="0 0 24 24"><Rect x="3" y="3" width="7" height="7" rx="1" {...stroke(color)} /><Rect x="14" y="3" width="7" height="7" rx="1" {...stroke(color)} /><Rect x="3" y="14" width="7" height="7" rx="1" {...stroke(color)} /><Path d="M14 14h3v3h-3zM20 14v1M14 20h1M17 17h4v4h-4" {...stroke(color)} /></Svg>
  ),
  Scan: ({ color, size = 24 }: IconProps) => (
    <Svg width={size} height={size} viewBox="0 0 24 24"><Path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3M4 12h16" {...stroke(color)} /></Svg>
  ),
  Unlink: ({ color, size = 20 }: IconProps) => (
    <Svg width={size} height={size} viewBox="0 0 24 24"><Path d="M9 15l6-6M7 12l-2 2a4 4 0 0 0 5 5l2-2M17 12l2-2a4 4 0 0 0-5-5l-2 2M4 4l16 16" {...stroke(color)} /></Svg>
  ),
  Plus: ({ color, size = 20 }: IconProps) => (
    <Svg width={size} height={size} viewBox="0 0 24 24"><Path d="M12 5v14M5 12h14" {...stroke(color)} /></Svg>
  ),
  Trash: ({ color, size = 18 }: IconProps) => (
    <Svg width={size} height={size} viewBox="0 0 24 24"><Path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" {...stroke(color)} /></Svg>
  ),
  Check: ({ color, size = 18 }: IconProps) => (
    <Svg width={size} height={size} viewBox="0 0 24 24"><Path d="M5 12l5 5 9-10" {...stroke(color)} /></Svg>
  ),
  Globe: ({ color, size = 18 }: IconProps) => (
    <Svg width={size} height={size} viewBox="0 0 24 24"><Circle cx="12" cy="12" r="9" {...stroke(color)} /><Path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" {...stroke(color)} /></Svg>
  ),
  Link: ({ color, size = 22 }: IconProps) => (
    <Svg width={size} height={size} viewBox="0 0 24 24"><Path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" {...stroke(color)} /><Path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" {...stroke(color)} /></Svg>
  ),
  Pause: ({ color, size = 18 }: IconProps) => (
    <Svg width={size} height={size} viewBox="0 0 24 24"><Rect x="6" y="4" width="4" height="16" rx="1" fill={color} /><Rect x="14" y="4" width="4" height="16" rx="1" fill={color} /></Svg>
  ),
};
