/**
 * Brand tokens, taken from the Bolverse icon: an indigo-to-violet "you" bubble and a cyan "them" bubble,
 * with an aurora gradient (cyan, blue, violet, pink) for AI moments.
 */
export const palette = {
  light: {
    bg: "#F7F6FF", surface: "#FFFFFF", ink: "#15123D", muted: "#5E5A86", line: "#E5E2F6",
    you: "#5B45FF", youInk: "#FFFFFF", youSoft: "#EEEBFF",
    them: "#3FD3F2", themInk: "#032836", themSoft: "#E3F9FE",
    accent: "#4C35F5", highlight: "#FFF1D6", danger: "#D92D5B", ok: "#12936A",
    gradA: "#22D3EE", gradB: "#3D5AFE", gradC: "#7B2FF7", gradD: "#F15BB5",
  },
  dark: {
    bg: "#0B0920", surface: "#17143D", ink: "#F2F0FF", muted: "#ABA6D8", line: "#2C2766",
    you: "#6E5BFF", youInk: "#FFFFFF", youSoft: "#241E5C",
    them: "#45D6F5", themInk: "#032836", themSoft: "#0F3A4A",
    accent: "#B4A9FF", highlight: "#2B2350", danger: "#FF7A9C", ok: "#4FD8A6",
    gradA: "#22D3EE", gradB: "#3D5AFE", gradC: "#7B2FF7", gradD: "#F15BB5",
  },
} as const;

export type Palette = { [K in keyof typeof palette.light]: string };
