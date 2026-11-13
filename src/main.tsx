import { StrictMode, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import App from "./App";
import { Login } from "./Login";
import { LOGIN_EVENT, api } from "./api";

type Me = { remote: boolean; authed: boolean; hasPassword: boolean };

function Root() {
  const [me, setMe] = useState<Me | null>(null);
  const check = useCallback(() => api.me().then(setMe).catch(() => setTimeout(check, 1500)), []);
  useEffect(() => {
    check();
    const lost = () => check();
    window.addEventListener(LOGIN_EVENT, lost);
    return () => window.removeEventListener(LOGIN_EVENT, lost);
  }, [check]);
  if (!me) return null;
  if (!me.authed) return <Login hasPassword={me.hasPassword} onDone={check} />;
  return <App remote={me.remote} onLogout={() => api.logout().then(check)} />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
