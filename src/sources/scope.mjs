// Demo mode (SEED_GUARD_DEMO=1): Notes are read only from a folder with this name, and screenshots come from a plain
// folder of test images (see photos.mjs), so a recording never shows the owner's real notes or screenshots.
// Nothing on screen changes.
export const DEMO_SCOPE = process.env.SEED_GUARD_DEMO === '1' ? 'Seed Guard Demo' : null;
