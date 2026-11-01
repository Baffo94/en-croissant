import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
    appId: "org.encroissant.mobile",
    appName: "En Croissant",
    webDir: "dist",
    android: {
        // GitHub API calls go through fetch; keep mixed content off.
        allowMixedContent: false,
    },
};

export default config;
