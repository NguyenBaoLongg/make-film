import { createClient } from '@supabase/supabase-js';
import { config } from '../config/env';

// This uses the SERVICE ROLE KEY. NEVER EXPOSE THIS TO THE FRONTEND.
// It bypasses Row Level Security (RLS) entirely, so only use it for secure backend operations.
export const supabaseAdmin = createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false
  }
});
