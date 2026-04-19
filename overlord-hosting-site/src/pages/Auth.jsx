import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Mail, Lock, User, ArrowRight } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

export default function Auth() {
  const [isLogin, setIsLogin] = useState(true);
  const navigate = useNavigate();

  const handleSubmit = (e) => {
    e.preventDefault();
    // Simulate auth & go to dashboard
    navigate('/dashboard');
  };

  return (
    <motion.div 
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.6 }}
      className="flex-1 flex flex-col items-center justify-center px-6 py-12"
    >
      <div className="w-full max-w-md">
        <div className="glass-panel rounded-3xl p-8 relative overflow-hidden shadow-2xl border border-white/10">
          {/* Decorative blur */}
          <div className="absolute -top-24 -right-24 w-48 h-48 bg-primary-500/20 rounded-full blur-[80px]" />
          <div className="absolute -bottom-24 -left-24 w-48 h-48 bg-blue-500/20 rounded-full blur-[80px]" />

          <div className="relative z-10 text-center mb-8">
            <h2 className="text-3xl font-bold text-white mb-2">
              {isLogin ? 'Welcome Back' : 'Create Account'}
            </h2>
            <p className="text-gray-400 text-sm">
              {isLogin 
                ? 'Enter your credentials to access your servers.' 
                : 'Sign up to deploy your Overlord instances.'}
            </p>
          </div>

          <form onSubmit={handleSubmit} className="relative z-10 space-y-5">
            <AnimatePresence mode="popLayout">
              {!isLogin && (
                <motion.div 
                  initial={{ opacity: 0, height: 0, overflow: 'hidden' }}
                  animate={{ opacity: 1, height: 'auto', overflow: 'visible' }}
                  exit={{ opacity: 0, height: 0, overflow: 'hidden' }}
                  className="space-y-1.5"
                >
                  <label className="text-sm font-medium text-gray-300">Username</label>
                  <div className="relative">
                    <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
                      <User className="w-5 h-5 text-gray-500" />
                    </div>
                    <input 
                      type="text" 
                      required
                      className="w-full bg-dark-800/50 border border-white/5 rounded-xl py-3 pl-11 pr-4 text-white focus:outline-none focus:border-primary-500/50 focus:ring-1 focus:ring-primary-500/50 transition-all placeholder-gray-600"
                      placeholder="overlord_user"
                    />
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            <div className="space-y-1.5">
              <label className="text-sm font-medium text-gray-300">Email Address</label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
                  <Mail className="w-5 h-5 text-gray-500" />
                </div>
                <input 
                  type="email" 
                  required
                  className="w-full bg-dark-800/50 border border-white/5 rounded-xl py-3 pl-11 pr-4 text-white focus:outline-none focus:border-primary-500/50 focus:ring-1 focus:ring-primary-500/50 transition-all placeholder-gray-600"
                  placeholder="admin@example.com"
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <label className="text-sm font-medium text-gray-300">Password</label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
                  <Lock className="w-5 h-5 text-gray-500" />
                </div>
                <input 
                  type="password" 
                  required
                  className="w-full bg-dark-800/50 border border-white/5 rounded-xl py-3 pl-11 pr-4 text-white focus:outline-none focus:border-primary-500/50 focus:ring-1 focus:ring-primary-500/50 transition-all placeholder-gray-600"
                  placeholder="••••••••••••"
                />
              </div>
            </div>

            <motion.button 
              whileHover={{ scale: 1.02 }}
              whileTap={{ scale: 0.98 }}
              type="submit"
              className="w-full flex items-center justify-center gap-2 bg-gradient-to-r from-primary-500 to-primary-400 hover:from-primary-400 hover:to-primary-300 text-dark-900 font-bold py-3.5 rounded-xl transition-all shadow-[0_0_15px_rgba(45,212,191,0.2)] hover:shadow-[0_0_25px_rgba(45,212,191,0.4)] mt-6"
            >
              {isLogin ? 'Sign In' : 'Register'}
              <ArrowRight className="w-4 h-4" />
            </motion.button>
          </form>

          <div className="relative z-10 mt-8 text-center text-sm text-gray-400">
            {isLogin ? "Don't have an account? " : "Already have an account? "}
            <button 
              onClick={() => setIsLogin(!isLogin)}
              className="text-primary-400 hover:text-primary-300 font-medium transition-colors border-b border-transparent hover:border-primary-300"
            >
              {isLogin ? "Register here" : "Sign in"}
            </button>
          </div>
        </div>
      </div>
    </motion.div>
  );
}
