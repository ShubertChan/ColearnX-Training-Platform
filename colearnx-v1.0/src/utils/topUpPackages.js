export const initialTopUpPackageState = {
  status: "loading",
  packages: [],
  error: "",
};

const validPackage = (plan) =>
  plan &&
  typeof plan.id === "string" && plan.id.length > 0 &&
  typeof plan.displayName === "string" &&
  Number.isSafeInteger(plan.amountMinor) && plan.amountMinor > 0 &&
  Number.isSafeInteger(plan.points) && plan.points > 0;

// Only the latest request may update the modal. Aborting also prevents a
// closed modal (or a StrictMode effect cleanup) from publishing a late result.
export function createTopUpPackageLoader(fetchPackages, onChange) {
  let revision = 0;
  let activeController;

  const cancel = () => {
    revision += 1;
    activeController?.abort();
    activeController = undefined;
  };

  const load = async () => {
    cancel();
    const requestRevision = revision;
    const controller = new AbortController();
    activeController = controller;
    onChange({ ...initialTopUpPackageState });

    try {
      const packages = await fetchPackages({ signal: controller.signal });
      if (requestRevision !== revision || controller.signal.aborted) return;
      if (!Array.isArray(packages) || !packages.every(validPackage)) {
        throw new Error("The service returned invalid top-up packages.");
      }
      onChange({ status: packages.length ? "ready" : "empty", packages, error: "" });
    } catch {
      if (requestRevision !== revision || controller.signal.aborted) return;
      onChange({
        status: "error",
        packages: [],
        error: "Unable to load top-up packages. Please check your connection and try again.",
      });
    } finally {
      if (requestRevision === revision) activeController = undefined;
    }
  };

  return { load, cancel };
}
