// 1. The crash guard loads first, before any other app code.
import { describeError } from "./src/crashGuard";
import { createElement } from "react";
import { ScrollView, Text, View } from "react-native";
import { registerRootComponent } from "expo";

// 2. Load the app itself inside a try, so a failure while it starts up (for example a native
//    part that didn't install) is shown on screen with the exact reason.
let Root: () => ReturnType<typeof createElement>;
try {
  Root = require("./src/App").default;
} catch (error) {
  const text = describeError(error);
  Root = () =>
    createElement(View, { style: { flex: 1, backgroundColor: "#F5F6FA", padding: 24, paddingTop: 72 } },
      createElement(Text, { style: { fontSize: 24, fontWeight: "800", color: "#0E1120", marginBottom: 8 } }, "Bolverse couldn't start"),
      createElement(Text, { style: { fontSize: 16, color: "#5A6075", marginBottom: 16 } }, "Please screenshot this screen and send it to the developer."),
      createElement(ScrollView, { style: { backgroundColor: "#FFFFFF", borderRadius: 14, padding: 14 } },
        createElement(Text, { selectable: true, style: { fontFamily: "monospace", fontSize: 13, color: "#C62828" } }, text)));
}

registerRootComponent(Root);
