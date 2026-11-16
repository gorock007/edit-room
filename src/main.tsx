import { StrictMode, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import App from "./App";
import { Login } from "./Login";
import { Join } from "./Join";
import { LOGIN_EVENT, api, type Me } from "./api";

function Root() {
  const [me, setMe] = useState<Me | null>(null);
  const [joining, setJoining] = useState(() => location.pathname === "/join");
  const check = useCallback(() => api.me().then(setMe).catch(() => setTimeout(check, 1500)), []);
  useEffect(() => {
    check();
    const lost = () => check();
    window.addEventListener(LOGIN_EVENT, lost);
    return () => window.removeEventListener(LOGIN_EVENT, lost);
  }, [check]);
  if (!me) return null;
  // an invite link: join as a new person (even if this device was someone else before)
  if (joining && me.remote)
    return (
      <Join
        onDone={() => {
          setJoining(false);
          check();
        }}
      />
    );
  if (!me.authed || !me.person) return <Login hasPassword={me.hasPassword} onDone={check} />;
  return <App me={me.person} remote={me.remote} publicUrl={me.publicUrl} onMeChanged={check} onLogout={() => api.logout().then(check)} />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
