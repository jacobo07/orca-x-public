/**
 * The product's name, as shown to the user.
 *
 * Kept apart from the packaging identity in `config/electron-builder.config.cjs` because the two
 * answer different questions: that file names the thing Windows installs, this one names the thing
 * on screen. They agree today and are expected to, but a build's identity is not something the
 * renderer should have to reach into the packager to learn.
 *
 * Deliberately NOT the source of the user-data directory. Electron derives that from the app's npm
 * name, and `configurePackagedUserDataPath` pins it, so renaming the product here cannot move
 * anyone's projects — see the comment there.
 */
export const PRODUCT_NAME = 'Orca X'
