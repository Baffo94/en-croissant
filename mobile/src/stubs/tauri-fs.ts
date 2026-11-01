// Stand-in for @tauri-apps/plugin-fs: the shared desktop helpers import it, but the
// functions that use it are never called by the mobile app.
function unavailable(): never {
    throw new Error("@tauri-apps/plugin-fs is not available on mobile");
}
export const BaseDirectory: Record<string, number> = {};
export const readTextFile = (..._args: unknown[]): Promise<string> => unavailable();
export const writeTextFile = (..._args: unknown[]): Promise<void> => unavailable();
