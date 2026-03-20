// worker.js

export default {
  async fetch(request, env) {
    return env.ASSETS.fetch(request);
  },

  async scheduled(event, env, ctx) {
    console.log(`Cron triggered at ${new Date(event.scheduledTime)} - ${event.cron}`);
    
  }
};
