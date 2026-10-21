import { useColorScheme } from "react-native";
import { palette, type Palette } from "@bolverse/shared";

export function useColors(): Palette {
  return useColorScheme() === "dark" ? palette.dark : palette.light;
}

export const fonts = {
  display: "BricolageGrotesque_800ExtraBold",
  displayBold: "BricolageGrotesque_700Bold",
};

export const radius = { tile: 28, card: 18, control: 14, pill: 999 };
