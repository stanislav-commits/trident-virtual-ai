import {
  Navigate,
  Outlet,
  Route,
  Routes,
  useLocation,
} from "react-router-dom";
import { AuthProvider, useAuth } from "./context/AuthContext";
import { ThemeProvider } from "./context/ThemeContext";
import { AdminPanelPage } from "./pages/AdminPanelPage";
import { HomePage } from "./pages/HomePage";
import { ChatPage } from "./pages/ChatPage";
import { DatasetPage } from "./pages/DatasetPage";
import { LoginPage } from "./pages/LoginPage";
import { PrivacyPolicyPage } from "./pages/PrivacyPolicyPage";
import { appRoutes } from "./utils/routes";

function RootRedirect() {
  const { isAuthenticated } = useAuth();

  return (
    <Navigate
      to={isAuthenticated ? appRoutes.chats : appRoutes.login}
      replace
    />
  );
}

function PublicOnlyRoute() {
  const { isAuthenticated } = useAuth();

  if (isAuthenticated) {
    return <Navigate to={appRoutes.chats} replace />;
  }

  return <Outlet />;
}

function RequireAuth() {
  const { isAuthenticated } = useAuth();
  const location = useLocation();

  if (!isAuthenticated) {
    return (
      <Navigate
        to={appRoutes.login}
        replace
        state={{
          from: {
            pathname: location.pathname,
            search: location.search,
            hash: location.hash,
          },
        }}
      />
    );
  }

  return <Outlet />;
}

function RequireAdmin() {
  const { user } = useAuth();

  if (user?.role !== "admin") {
    return <Navigate to={appRoutes.chats} replace />;
  }

  return <Outlet />;
}

function UnknownRouteRedirect() {
  const { isAuthenticated } = useAuth();

  return (
    <Navigate
      to={isAuthenticated ? appRoutes.chats : appRoutes.login}
      replace
    />
  );
}

function AppContent() {
  return (
    <Routes>
      <Route path={appRoutes.root} element={<RootRedirect />} />
      <Route element={<PublicOnlyRoute />}>
        <Route path={appRoutes.login} element={<LoginPage />} />
      </Route>
      <Route path={appRoutes.privacy} element={<PrivacyPolicyPage />} />
      <Route element={<RequireAuth />}>
        <Route path={appRoutes.home} element={<HomePage />} />
        <Route path={appRoutes.chats} element={<ChatPage />} />
        <Route path={appRoutes.chatSessionPattern} element={<ChatPage />} />
        <Route path={appRoutes.dataset} element={<DatasetPage />} />
        <Route element={<RequireAdmin />}>
          <Route
            path={appRoutes.admin}
            element={<Navigate to={appRoutes.adminSection("users")} replace />}
          />
          <Route
            path={appRoutes.adminSectionPattern}
            element={<AdminPanelPage />}
          />
        </Route>
      </Route>
      <Route path="*" element={<UnknownRouteRedirect />} />
    </Routes>
  );
}

function App() {
  return (
    <ThemeProvider>
      <AuthProvider>
        <AppContent />
      </AuthProvider>
    </ThemeProvider>
  );
}

export default App;
