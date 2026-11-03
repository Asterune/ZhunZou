/**
 * Baked into the standalone bundle by scripts/build-standalone.mjs so a
 * downloaded mcp.mjs / cli.mjs knows exactly which release it is.
 *
 * The `typeof` guard keeps the source build (`tsc`, dev runs) working: there
 * the identifier is never defined at runtime.
 */
declare const __ZHUNZOU_BRIDGE_VERSION__: string | undefined;

export const BRIDGE_VERSION: string =
  typeof __ZHUNZOU_BRIDGE_VERSION__ === 'string'
    ? __ZHUNZOU_BRIDGE_VERSION__
    : '0.0.0-dev';
