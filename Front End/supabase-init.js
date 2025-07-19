// supabase-init.js
import { createClient } from 'https://esm.sh/@supabase/supabase-js'

// Replace these with YOUR values from Supabase
const SUPABASE_URL = 'https://itnvtpaybjqsjfcgnlnz.supabase.co'
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml0bnZ0cGF5Ympxc2pmY2dubG56Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTI4MzQ0NDMsImV4cCI6MjA2ODQxMDQ0M30.sTODhaOdqQGvhLuWPe7IKuktYw2VvlNyKEwDfKEJoHQ'

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)