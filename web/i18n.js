import en from "./locales/en.js";
import zh from "./locales/zh.js";

const catalogs = new Map([["en", en], ["zh", zh], ["zh-cn", zh], ["zh-hans", zh], ["zh-sg", zh]]);
let messages = en;

export function setLocale(locale) {
  messages = catalogs.get(String(locale ?? "").toLowerCase()) ?? en;
}

export function t(key, values = {}) {
  const pattern = messages[key] ?? en[key] ?? key;
  return pattern.replace(/\{(\w+)\}/g, (placeholder, name) => values[name] ?? placeholder);
}

export function apiError({ error, source, detail }) {
  const key = Object.hasOwn(en, error) ? error : "error.requestFailed";
  const message = t(key, source ? { source: t(source) } : {});
  return detail ? `${message}\n${detail}` : message;
}
