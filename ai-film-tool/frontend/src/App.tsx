import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useAuth } from './hooks/useAuth';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import CreateProject from './pages/CreateProject';
import ProjectDetail from './pages/ProjectDetail';
import Workspace from './pages/Workspace';

function PrivateRoute({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  
  if (loading) {
    return <div className="flex h-screen items-center justify-center bg-background text-foreground">Loading...</div>;
  }
  
  if (!user) {
    return <Navigate to="/login" />;
  }

  return <>{children}</>;
}

function App() {
  return (
    <Router>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route 
          path="/dashboard" 
          element={
            <PrivateRoute>
              <Dashboard />
            </PrivateRoute>
          } 
        />
        <Route 
          path="/projects/new" 
          element={
            <PrivateRoute>
              <CreateProject />
            </PrivateRoute>
          } 
        />
        <Route 
          path="/projects/:id" 
          element={
            <PrivateRoute>
              <ProjectDetail />
            </PrivateRoute>
          } 
        />
        <Route 
          path="/" 
          element={
            <PrivateRoute>
              <Workspace />
            </PrivateRoute>
          } 
        />
      </Routes>
    </Router>
  );
}

export default App;
