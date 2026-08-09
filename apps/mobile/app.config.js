// Variante do app: APP_VARIANT=development => "Orbit (Dev)" / com.fragmentslabs.orbit.dev
// Sem APP_VARIANT (ou "production")        => "Orbit" / com.fragmentslabs.orbit
const IS_DEV = process.env.APP_VARIANT === "development";

const applyVariant = (id) => (IS_DEV ? `${id}.dev` : id);

export default ({ config }) => ({
  ...config,
  name: IS_DEV ? "Orbit (Dev)" : config.name,
  ios: {
    ...config.ios,
    bundleIdentifier: applyVariant(config.ios.bundleIdentifier),
  },
  android: {
    ...config.android,
    package: applyVariant(config.android.package),
  },
  extra: {
    ...config.extra,
    appVariant: IS_DEV ? "development" : "production",
  },
});