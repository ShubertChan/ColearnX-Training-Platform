import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ShieldCheck } from "lucide-react";
import { getMfaStatus } from "../api/auth";
import { EmptyState, Button } from "./ui";

export default function AdminMfaGate({ children }) {
  const [state, setState] = useState({ loading: true });
  const [revision, setRevision] = useState(0);
  const retry = useCallback(() => setRevision(value => value + 1), []);
  useEffect(() => {
    let current = true;
    setState({ loading: true });
    getMfaStatus().then(status => { if (current) setState({ enrolled: status.enrolled }); })
      .catch(error => { if (current) setState({ error: error.message }); });
    return () => { current = false; };
  }, [revision]);
  if (state.loading) return <p role="status">Checking administrator security…</p>;
  if (state.error) return <EmptyState title="Security check unavailable" description={state.error} action={<Button onClick={retry}>Retry security check</Button>} />;
  if (!state.enrolled) return <EmptyState icon={ShieldCheck} title="Set up two-factor authentication" description="Administrator pages require an authenticator. Set it up and save your recovery codes before reviewing applications or files." action={<Link className="button primary" to="/security">Open security settings</Link>} />;
  return children;
}
