import { Component, type ReactNode } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";

/**
 * Catches errors while drawing the app and shows them, instead of letting Android close the app
 * with its "something went wrong" dialog. The message tells us exactly what to fix.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <View style={{ flex: 1, backgroundColor: "#F5F6FA", padding: 24, paddingTop: 72 }}>
        <Text style={{ fontSize: 24, fontWeight: "800", color: "#0E1120", marginBottom: 8 }}>Bolverse hit a problem</Text>
        <Text style={{ fontSize: 16, color: "#5A6075", marginBottom: 16 }}>
          Take a screenshot of this screen and send it to the developer, then tap Try again.
        </Text>
        <ScrollView style={{ maxHeight: 320, backgroundColor: "#FFFFFF", borderRadius: 14, padding: 14, marginBottom: 20 }}>
          <Text selectable style={{ fontFamily: "monospace", fontSize: 13, color: "#C62828" }}>
            {error.name}: {error.message}{"\n\n"}{(error.stack ?? "").split("\n").slice(0, 12).join("\n")}
          </Text>
        </ScrollView>
        <Pressable onPress={() => this.setState({ error: null })}
          style={{ backgroundColor: "#2F3CF4", borderRadius: 14, padding: 15, alignItems: "center" }}>
          <Text style={{ color: "#FFFFFF", fontSize: 17, fontWeight: "700" }}>Try again</Text>
        </Pressable>
      </View>
    );
  }
}
