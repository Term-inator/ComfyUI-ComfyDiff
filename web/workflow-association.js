export function reconcileAssociation(settings, previous) {
  if (!settings.file && settings.workspace === previous?.workspace && previous?.source === "match") {
    return { ...settings, file: previous.file, source: previous.source };
  }
  return settings;
}
