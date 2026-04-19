import { useState, useEffect } from 'react';
import { BrowserRouter as Router, Routes, Route, Link } from 'react-router-dom';
import Landing from './pages/Landing';
import Auth from './pages/Auth';
import Dashboard from './pages/Dashboard';
import { Server, Activity } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

function App() {
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Simulate initial loading sequence for aesthetic
    const timer = setTimeout(() => {
      setLoading(false);
    }, 2500);
    return () => clearTimeout(timer);
  }, []);

  return (
    <Router>
      <div className="min-h-screen bg-dark-900 bg-grid-pattern relative overflow-x-hidden">
        
        <AnimatePresence>
          {loading && (
            <motion.div
              key="loader"
              initial={{ opacity: 1 }}
              exit={{ opacity: 0, transition: { duration: 0.8, ease: "easeInOut" } }}
              className="fixed inset-0 z-[100] bg-dark-900 flex flex-col items-center justify-center"
            >
              <div className="relative">
                <motion.div
                  animate={{ rotate: 360 }}
                  transition={{ repeat: Infinity, duration: 2, ease: "linear" }}
                  className="w-24 h-24 rounded-full border-t-2 border-primary-500 border-r-2 border-r-primary-500/30 border-b-2 border-b-transparent border-l-2 border-l-transparent absolute top-0 left-0"
                />
                <div className="w-24 h-24 flex items-center justify-center">
                  <Activity className="w-8 h-8 text-primary-400 animate-pulse" />
                </div>
              </div>
              <motion.div 
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.5 }}
                className="mt-8 text-primary-400 font-mono text-sm tracking-[0.2em] uppercase"
              >
                Initializing Node
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Glow Effects */}
        <div className="fixed top-[-20%] left-[-10%] w-[50%] h-[50%] rounded-full bg-primary-600/10 blur-[120px] pointer-events-none" />
        <div className="fixed bottom-[-20%] right-[-10%] w-[50%] h-[50%] rounded-full bg-blue-600/5 blur-[120px] pointer-events-none" />
        
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: loading ? 0 : 1 }}
          transition={{ duration: 1, delay: 2.2 }}
        >
          {/* Navigation */}
          <nav className="fixed w-full z-50 glass-panel border-x-0 border-t-0 border-b-white/5 py-4">
            <div className="container mx-auto px-6 flex justify-between items-center">
              <Link to="/" className="flex items-center gap-2 group">
                <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-primary-400 to-primary-600 flex items-center justify-center shadow-lg shadow-primary-500/20 group-hover:shadow-primary-500/40 transition-shadow">
                  <Server className="w-5 h-5 text-dark-900" />
                </div>
                <span className="text-xl font-bold tracking-tight text-white group-hover:text-primary-400 transition-colors">
                  Overlord<span className="text-primary-400">Hosting</span>
                </span>
              </Link>
              
              <div className="flex items-center gap-4">
                <Link to="/auth" className="text-sm font-medium text-gray-300 hover:text-white transition-colors px-4 py-2">
                  Login
                </Link>
                <Link to="/auth" className="text-sm font-medium text-dark-900 bg-primary-400 hover:bg-primary-300 transition-colors px-5 py-2.5 rounded-lg shadow-lg shadow-primary-500/25 hidden sm:block">
                  Deploy Now
                </Link>
              </div>
            </div>
          </nav>

          {/* Main Content Area */}
          <main className="pt-24 pb-12 min-h-screen relative z-10 flex flex-col">
            <Routes>
              <Route path="/" element={<Landing />} />
              <Route path="/auth" element={<Auth />} />
              <Route path="/dashboard" element={<Dashboard />} />
            </Routes>
          </main>
        </motion.div>
      </div>
    </Router>
  );
}

export default App;
