import { CheckCircle2, ExternalLink } from 'lucide-react';
import { motion } from 'framer-motion';

export default function Dashboard() {
  return (
    <motion.div 
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.6 }}
      className="flex-1 flex flex-col items-center justify-center px-6 py-12"
    >
      <div className="w-full max-w-2xl text-center">
        
        <motion.div 
          initial={{ scale: 0 }}
          animate={{ scale: 1 }}
          transition={{ type: "spring", stiffness: 200, delay: 0.2 }}
          className="mb-12 inline-flex items-center justify-center w-20 h-20 rounded-full bg-primary-500/10 border border-primary-500/20 shadow-lg shadow-primary-500/10 relative"
        >
          <div className="absolute inset-0 rounded-full bg-primary-400/20 blur-xl animate-pulse" />
          <CheckCircle2 className="w-10 h-10 text-primary-400 relative z-10" />
        </motion.div>

        <h1 className="text-4xl lg:text-5xl font-bold text-white mb-6 tracking-tight">
          Account Created Successfully
        </h1>
        
        <div className="glass-panel rounded-3xl p-8 lg:p-10 mb-8 border border-white/10 shadow-2xl relative overflow-hidden">
          <div className="absolute top-0 right-0 w-64 h-64 bg-primary-500/10 rounded-full blur-[100px] pointer-events-none" />
          <div className="absolute bottom-0 left-0 w-64 h-64 bg-blue-500/10 rounded-full blur-[100px] pointer-events-none" />
          
          <div className="relative z-10 space-y-6">
            <p className="text-xl text-gray-300 leading-relaxed">
              Your Overlord account is now active. To deploy and manage your servers, you need to access the Overlord control panel.
            </p>
            
            <div className="bg-dark-900/50 border border-white/5 rounded-xl p-6 text-left">
              <h3 className="text-sm font-semibold text-primary-400 uppercase tracking-wider mb-2">Instructions</h3>
              <p className="text-gray-400">
                Please proceed to <strong className="text-white relative"><span className="absolute inset-0 bg-primary-500/20 blur-sm rounded" />panel.overlord-hosting.xyz</strong> and log in using the exact username and password you just created on this site.
              </p>
            </div>
            
            <a 
              href="https://panel.overlord-hosting.xyz" 
              target="_blank" 
              rel="noopener noreferrer"
              className="inline-flex items-center justify-center gap-2 w-full sm:w-auto bg-gradient-to-r from-primary-500 to-primary-400 hover:from-primary-400 hover:to-primary-300 text-dark-900 font-bold px-8 py-4 rounded-xl transition-all shadow-[0_0_20px_rgba(45,212,191,0.3)] hover:shadow-[0_0_40px_rgba(45,212,191,0.5)] transform hover:-translate-y-1"
            >
              Take me to Overlord
              <ExternalLink className="w-5 h-5" />
            </a>
          </div>
        </div>
      </div>
    </motion.div>
  );
}
