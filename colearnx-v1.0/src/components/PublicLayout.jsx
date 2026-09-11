import { Link, NavLink } from "react-router-dom";
import { usePlatform } from "../context/PlatformContext";
import nextLogo from "../../assets/next-logo.jpg";
import { useRef } from "react";

export default function PublicLayout({ children }) {
  const { authenticated, role } = usePlatform();
  const mainRef = useRef(null);
  return (
    <div className="public-shell">
      <a className="skip-link" href="#main-content" onClick={(event) => { event.preventDefault(); mainRef.current?.focus(); }}>Skip to main content</a>
      <header className="public-header">
        <Link className="public-brand" to="/courses">
          <img src={nextLogo} alt="neXt" />
          <span><b>CoLearnX</b><small>Learning marketplace</small></span>
        </Link>
        <nav aria-label="Public navigation">
          <NavLink to="/courses">Courses</NavLink>
          <NavLink to="/contents">Resources</NavLink>
        </nav>
        <div className="public-auth-actions">
          {authenticated ? (
            <Link className="button primary sm" to={role === "Admin" ? "/admin" : "/home"}>Open workspace</Link>
          ) : (
            <><Link className="button secondary sm" to="/login">Sign in</Link><Link className="button primary sm" to="/register">Create account</Link></>
          )}
        </div>
      </header>
      <main ref={mainRef} tabIndex={-1} className="public-main" id="main-content">{children}</main>
      <footer className="public-footer">
        <span>CoLearnX</span>
        <nav aria-label="Legal"><Link to="/terms">Terms</Link><Link to="/privacy">Privacy Notice</Link></nav>
      </footer>
    </div>
  );
}
