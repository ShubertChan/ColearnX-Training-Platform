// Each catalogue can fail independently without discarding its last good data.
export async function loadCatalogSection({ fetchItems, mapItem, setItems, setState }) {
  setState({ status: "loading", error: "" });
  try {
    const items = (await fetchItems()).map(mapItem);
    setItems(items);
    setState({ status: "ready", error: "" });
    return true;
  } catch {
    setState({ status: "error", error: "Could not load the latest listings. Please try again." });
    return false;
  }
}
