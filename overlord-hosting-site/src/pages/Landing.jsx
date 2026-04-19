import { Link } from 'react-router-dom';
import { Shield, Zap, Server, ChevronRight, Bitcoin, CreditCard, Lock, EyeOff, TerminalSquare, Globe } from 'lucide-react';
import { motion } from 'framer-motion';

export default function Landing() {
  const containerVariants = {
    hidden: { opacity: 0 },
    visible: { 
      opacity: 1, 
      transition: { staggerChildren: 0.1, delayChildren: 0.2 } 
    }
  };

  const itemVariants = {
    hidden: { opacity: 0, y: 20 },
    visible: { opacity: 1, y: 0, transition: { duration: 0.6, ease: "easeOut" } }
  };

  return (
    <div className="flex-1 flex flex-col items-center">
      
      {/* Hero Section */}
      <section className="w-full max-w-7xl mx-auto px-6 py-24 min-h-[85vh] flex flex-col justify-center items-center text-center relative">
        <motion.div 
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.8 }}
          className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-white/5 border border-white/10 text-primary-400 text-sm font-medium mb-8 shadow-[0_0_15px_rgba(45,212,191,0.2)]"
        >
          <Lock className="w-4 h-4" />
          <span>99% DMCA Ignored Infrastructure</span>
        </motion.div>
        
        <motion.h1 
          initial={{ opacity: 0, y: 30 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8, delay: 0.2 }}
          className="text-6xl md:text-7xl lg:text-8xl font-black tracking-tighter text-white mb-6 leading-tight"
        >
          Bulletproof <br className="hidden md:block" />
          <span className="text-transparent bg-clip-text bg-gradient-to-r from-primary-400 via-blue-500 to-purple-600">
            Overlord Hosting
          </span>
        </motion.h1>
        
        <motion.p 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8, delay: 0.4 }}
          className="text-xl text-gray-400 max-w-3xl mb-12"
        >
          Untraceable routing, dedicated outbound IPs, and absolute privacy. 
          Perfectly tailored for C2 frameworks, proxy layers, and completely anonymous operations. 
          We ask no questions.
        </motion.p>

        <motion.div 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8, delay: 0.6 }}
          className="flex flex-col sm:flex-row items-center gap-6"
        >
          <Link to="/auth" className="flex items-center gap-2 bg-gradient-to-r from-primary-500 to-primary-400 hover:from-primary-400 hover:to-primary-300 text-dark-900 font-bold px-10 py-5 rounded-2xl transition-all shadow-[0_0_30px_rgba(45,212,191,0.3)] hover:shadow-[0_0_50px_rgba(45,212,191,0.5)] transform hover:-translate-y-1 text-lg">
            Deploy Secure Node
            <TerminalSquare className="w-6 h-6" />
          </Link>
        </motion.div>
      </section>

      {/* Feature Section 1 */}
      <section className="w-full relative py-24 border-y border-white/5 bg-white/[0.02]">
        <div className="max-w-7xl mx-auto px-6">
          <motion.div 
            initial={{ opacity: 0, y: 40 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: "-100px" }}
            transition={{ duration: 0.8 }}
            className="text-center mb-20"
          >
            <h2 className="text-3xl md:text-5xl font-bold text-white mb-6">Designed for Control</h2>
            <p className="text-xl text-gray-400 max-w-2xl mx-auto">
              Our infrastructure is built from the ground up to support high-intensity operations, reverse connections, and complete remote administration without throttling.
            </p>
          </motion.div>

          <motion.div 
            variants={containerVariants}
            initial="hidden"
            whileInView="visible"
            viewport={{ once: true, margin: "-50px" }}
            className="grid md:grid-cols-2 lg:grid-cols-4 gap-6"
          >
            {[
              {
                icon: <EyeOff className="w-8 h-8 text-primary-400" />,
                title: '99% DMCA Ignored',
                desc: 'Offshore jurisdictions ensure your operations stay online. We ignore virtually all takedown requests targeting our subnets.'
              },
              {
                icon: <Globe className="w-8 h-8 text-blue-400" />,
                title: 'Unmetered Egress',
                desc: 'No bandwidth caps or throttling on outbound traffic. Maintain persistent outbound connections without arbitrary limits.'
              },
              {
                icon: <Shield className="w-8 h-8 text-purple-400" />,
                title: 'Inline DDoS Mitigation',
                desc: 'L4/L7 custom filtering to protect your control server from automated scraping and targeted denial of service attacks.'
              },
              {
                icon: <Server className="w-8 h-8 text-emerald-400" />,
                title: 'Root SSH Access',
                desc: 'Complete bare-metal execution environment. Install custom proxies, compile payloads, and configure your own TLS tunnels.'
              }
            ].map((feature, idx) => (
              <motion.div key={idx} variants={itemVariants} className="glass-panel p-8 rounded-3xl glass-panel-hover flex flex-col h-full border border-white/5">
                <div className="mb-6">{feature.icon}</div>
                <h3 className="text-2xl font-bold text-white mb-4">{feature.title}</h3>
                <p className="text-gray-400 leading-relaxed flex-1">{feature.desc}</p>
              </motion.div>
            ))}
          </motion.div>
        </div>
      </section>

      {/* Advanced Features */}
      <section className="w-full max-w-7xl mx-auto px-6 py-32">
        <div className="flex flex-col lg:flex-row items-center gap-16">
          <motion.div 
            initial={{ opacity: 0, x: -50 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.8 }}
            className="lg:w-1/2"
          >
            <h2 className="text-4xl md:text-5xl font-bold text-white mb-6 leading-tight">
              Optimized for <br/> <span className="text-primary-400">Remote Administration</span>
            </h2>
            <p className="text-xl text-gray-400 mb-8 leading-relaxed">
              Whether you're managing heavily encrypted endpoints, routing HVNC sessions, or coordinating distributed agent networks, our network provides the lowest latency and highest persistence available.
            </p>
            <ul className="space-y-6">
              {[
                'Full support for WebSocket and TCP reverse proxies',
                'Pre-configured for automated TLS offloading',
                'No logging of incoming connection IP addresses',
                'Isolated container environments to prevent cross-tenant bleeding'
              ].map((item, i) => (
                <li key={i} className="flex items-start gap-4 text-gray-300">
                  <div className="w-6 h-6 rounded-full bg-primary-500/20 flex items-center justify-center shrink-0 mt-1">
                    <div className="w-2 h-2 rounded-full bg-primary-400" />
                  </div>
                  <span className="text-lg">{item}</span>
                </li>
              ))}
            </ul>
          </motion.div>
          <motion.div 
            initial={{ opacity: 0, scale: 0.9 }}
            whileInView={{ opacity: 1, scale: 1 }}
            viewport={{ once: true }}
            transition={{ duration: 0.8 }}
            className="lg:w-1/2 w-full relative"
          >
            <div className="absolute inset-0 bg-primary-500/20 blur-[100px] rounded-full" />
            <div className="glass-panel p-2 rounded-2xl relative border-white/10 shadow-2xl">
               <div className="bg-dark-900 rounded-xl overflow-hidden font-mono text-sm border border-white/5">
                 <div className="bg-dark-800 px-4 py-3 border-b border-white/5 flex items-center gap-2">
                   <div className="flex gap-1.5">
                     <div className="w-3 h-3 rounded-full bg-red-500" />
                     <div className="w-3 h-3 rounded-full bg-yellow-500" />
                     <div className="w-3 h-3 rounded-full bg-green-500" />
                   </div>
                   <div className="mx-auto text-gray-500 text-xs">overlord@relay-node-01:~</div>
                 </div>
                 <div className="p-6 text-emerald-400 space-y-2 opacity-90 h-80 overflow-hidden flex flex-col justify-end">
                   <p>overlord@node:~$ sudo systemctl enable --now overlord-tunnel</p>
                   <p className="text-gray-400">[INFO] Creating symlink /etc/systemd/system/multi-user.target.wants/overlord.service</p>
                   <p>overlord@node:~$ ./overlord --bind 0.0.0.0:443 --tls-offload=true</p>
                   <p className="text-blue-400">[2026-04-18 16:42:36] INITIALIZING HVNC LISTENER ON 0.0.0.0:443</p>
                   <p className="text-blue-400">[2026-04-18 16:42:37] BINDING TLS CERTIFICATES... OK</p>
                   <p className="text-green-400 animate-pulse">[2026-04-18 16:42:38] WAITING FOR INBOUND CONNECTIONS...</p>
                 </div>
               </div>
            </div>
          </motion.div>
        </div>
      </section>

      {/* Pricing Section */}
      <section id="pricing" className="w-full py-32 bg-white/[0.01] border-t border-white/5">
        <div className="max-w-5xl mx-auto px-6">
          <motion.div 
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            className="text-center mb-20"
          >
            <div className="inline-flex items-center justify-center p-3 rounded-2xl bg-primary-500/10 mb-6 border border-primary-500/20">
              <Bitcoin className="w-8 h-8 text-primary-400" />
            </div>
            <h2 className="text-4xl md:text-5xl font-bold text-white mb-6">Anonymous Access</h2>
            <p className="text-xl text-gray-400 max-w-2xl mx-auto">
              We don't need your identity. We don't ask for your KYC. Just send Crypto and deploy instantly.
            </p>
          </motion.div>

          <motion.div 
            initial={{ opacity: 0, y: 30 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            className="glass-panel w-full rounded-[2rem] p-8 lg:p-14 relative overflow-hidden border-primary-500/30"
          >
            <div className="absolute top-0 right-0 w-96 h-96 bg-primary-500/10 rounded-full blur-[80px] pointer-events-none" />
            
            <div className="flex flex-col lg:flex-row items-center justify-between gap-16 relative z-10">
              <div className="flex-1">
                <div className="inline-block px-5 py-2 rounded-xl bg-primary-500/20 text-primary-300 font-bold tracking-wide mb-6 uppercase text-sm">
                  Base Deployment
                </div>
                <h3 className="text-5xl font-black text-white mb-4">Node Setup</h3>
                <p className="text-xl text-gray-400 mb-10">Standard untraceable node. Upgrade anytime.</p>
                
                <div className="grid sm:grid-cols-2 gap-6">
                  {[
                    'Anonymous Registration', 'Shared 10Gbps Uplink', 
                    'Full Root Access', 'Unfiltered Outbound Ports',
                    'Dedicated Clean IP', 'Instant Provisioning'
                  ].map((feature, i) => (
                    <div key={i} className="flex items-center gap-3 text-gray-300 font-medium">
                      <div className="p-1 rounded-full bg-primary-500/20 flex items-center justify-center text-primary-400">
                        <Zap className="w-4 h-4" />
                      </div>
                      {feature}
                    </div>
                  ))}
                </div>
              </div>

              <div className="glass-panel p-10 rounded-3xl border-white/10 w-full lg:w-[400px] flex flex-col items-center justify-center text-center shadow-2xl bg-dark-900/80">
                <div className="text-primary-400 font-bold uppercase tracking-wider mb-4">Starting At</div>
                <div className="flex items-start justify-center gap-1 mb-8">
                  <span className="text-3xl text-gray-400 font-bold mt-2">€</span>
                  <span className="text-7xl font-black text-white tracking-tighter">14.99</span>
                  <span className="text-gray-500 mt-auto mb-2 font-medium">/mo</span>
                </div>
                <Link to="/auth" className="w-full bg-gradient-to-r from-primary-500 to-primary-400 hover:from-primary-400 hover:to-primary-300 text-dark-900 font-black text-xl py-5 rounded-2xl transition-all shadow-[0_0_20px_rgba(45,212,191,0.2)] hover:shadow-[0_0_40px_rgba(45,212,191,0.4)] hover:-translate-y-1">
                  Purchase Now
                </Link>
                <div className="mt-6 text-sm text-gray-500 flex items-center justify-center gap-2 font-medium">
                  <Lock className="w-4 h-4" />
                  BTC, XMR, ETH Accepted
                </div>
              </div>
            </div>
          </motion.div>
        </div>
      </section>

      {/* Footer */}
      <footer className="w-full py-12 border-t border-white/5 text-center text-gray-500 mt-auto">
        <p className="font-medium text-sm">© 2026 Overlord Hosting. Total Anonymity.</p>
      </footer>
    </div>
  );
}
