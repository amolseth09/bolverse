import { useMemo, type ReactNode } from "react";
import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Svg, { Path } from "react-native-svg";
import type { Palette } from "@bolverse/shared";
import { fonts, useColors } from "../lib/theme";

export function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const s = useMemo(() => makeStyles(c), [c]);
  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior="padding">
        <Pressable style={s.scrim} onPress={onClose} accessibilityLabel="Close" />
        <View style={[s.sheet, { paddingBottom: insets.bottom + 20 }]} accessibilityViewIsModal>
          <Pressable style={s.close} onPress={onClose} accessibilityRole="button" accessibilityLabel="Close" hitSlop={12}>
            <Svg width={22} height={22} viewBox="0 0 24 24"><Path d="M6 6l12 12M18 6L6 18" stroke={c.muted} strokeWidth={2} strokeLinecap="round" /></Svg>
          </Pressable>
          <ScrollView keyboardShouldPersistTaps="handled">
            <Text style={s.title} accessibilityRole="header">{title}</Text>
            {children}
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  scrim: { flex: 1, backgroundColor: "rgba(11,9,32,0.5)" },
  sheet: { maxHeight: "92%", backgroundColor: c.surface, borderTopLeftRadius: 30, borderTopRightRadius: 30, paddingTop: 28, paddingHorizontal: 22, borderTopWidth: 3, borderLeftWidth: 1, borderRightWidth: 1, borderColor: c.you },
  close: { position: "absolute", top: 16, right: 16, zIndex: 2 },
  title: { fontFamily: fonts.display, fontSize: 26, lineHeight: 30, color: c.ink, letterSpacing: -0.5, marginBottom: 8, paddingRight: 32 },
});
