const { Bot, session } = require("grammy");
const { createClient } = require("@supabase/supabase-js");

// CORS headers for public access
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Constants for unrestriction timeouts and retries
const UNRESTRICT_TIMEOUT = 8000; // 8 seconds to allow for Vercel's 10s timeout
const UNRESTRICT_RETRY_DELAY = 1000; // 1 second between retries
const MAX_UNRESTRICT_RETRIES = 3; // Maximum number of retries for unrestriction
const GRACE_PERIOD = 60 * 1000; // 60 seconds grace period after verification

// Helper function for delayed execution
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Initialize Supabase client with proper auth
const supabaseUrl = process.env.SUPABASE_URL || "";
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false
  }
});

// Initialize Telegram bot
const botToken = process.env.TELEGRAM_BOT_TOKEN || "";
const bot = new Bot(botToken);

// Log bot initialization
console.log(`Bot initialized with token: ${botToken ? "✓ Token exists" : "✗ No token found"}`);
console.log(`Supabase initialized with URL: ${supabaseUrl ? "✓ URL exists" : "✗ No URL found"}`);
console.log(`Supabase key: ${supabaseKey ? supabaseKey.substring(0, 5) + "..." : "✗ No key found"}`);

// Track recently verified users to prevent re-restriction loops
const verifiedUsers = new Map();
// Track users currently being processed to prevent concurrent operations
const processingUsers = new Map();
// Track users who have been restricted by the bot to prevent re-restriction
const restrictedByBot = new Map();
// Track users who have been unrestricted by the bot
const unrestrictedByBot = new Map();
// Track users who have failed database verification but are verified in memory
const memoryVerifiedUsers = new Map();
// Track users who are currently being restricted to prevent race conditions
const restrictingUsers = new Map();
// Track users who are currently being unrestricted to prevent race conditions
const unrestrictingUsers = new Map();
// Track users who have pending captchas
const pendingCaptchas = new Map();
// Track users in grace period after verification
const graceUsers = new Map();
// Track permanently verified users (those who have sent a message after verification)
const permanentlyVerifiedUsers = new Map();

// Initialize session
bot.use(
  session({
    initial: () => ({
      captcha: "",
      attempts: 0,
    }),
  })
);

// Generate a random 6-digit alphanumerical captcha
function generateCaptcha() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let result = "";
  for (let i = 0; i < 6; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

// Add the attribution footer to messages
function addAttribution(message) {
  return `${message}\n\n[created for you by POWERCITY.io](https://powercity.io)`;
}

// Function to check if a user was recently verified
function isRecentlyVerified(userId, chatId) {
  const key = `${userId}:${chatId}`;
  return verifiedUsers.has(key) || memoryVerifiedUsers.has(key) || permanentlyVerifiedUsers.has(key);
}

// Function to check if a user is in grace period (now checks database)
async function isInGracePeriod(userId, chatId) {
  try {
    // First check in memory for faster response (though this won't persist across serverless invocations)
    const key = `${userId}:${chatId}`;
    const inMemoryGrace = graceUsers.has(key);
    
    if (inMemoryGrace) {
      console.log(`GRACE CHECK: User ${userId} in chat ${chatId} is in grace period (memory): true`);
      return true;
    }
    
    // Then check the database
    console.log(`GRACE CHECK: Checking database for grace period status of user ${userId} in chat ${chatId}`);
    const now = new Date();
    const graceExpiry = new Date(now.getTime() - GRACE_PERIOD); // Grace period ago
    
    const { data, error } = await supabase
      .from("verified_users")
      .select("*")
      .eq("user_id", userId)
      .eq("chat_id", chatId)
      .gte("verified_at", graceExpiry.toISOString())
      .single();
    
    if (error && error.code !== "PGRST116") { // PGRST116 is "no rows returned" which is fine
      console.error("Error checking grace period status:", error);
      return inMemoryGrace; // Fall back to memory check
    }
    
    const isInGrace = data ? true : false;
    console.log(`GRACE CHECK: User ${userId} in chat ${chatId} is in grace period (database): ${isInGrace}`);
    
    if (isInGrace) {
      // Also store in memory for faster subsequent checks
      markUserInGracePeriod(userId, chatId);
      
      // Calculate remaining time
      const verifiedAt = new Date(data.verified_at);
      const elapsedMs = now.getTime() - verifiedAt.getTime();
      const remainingSecs = Math.max(0, Math.floor((GRACE_PERIOD - elapsedMs) / 1000));
      console.log(`GRACE INFO: ${remainingSecs} seconds remaining in grace period`);
    }
    
    return isInGrace;
  } catch (error) {
    console.error("Exception checking grace period status:", error);
    return false;
  }
}

// Function to mark a user as in grace period (now updates database)
function markUserInGracePeriod(userId, chatId) {
  const key = `${userId}:${chatId}`;
  const now = Date.now();
  graceUsers.set(key, now);

  console.log(`GRACE PERIOD: Marked user ${userId} as in grace period for chat ${chatId} at ${new Date(now).toISOString()}`);
  console.log(`GRACE PERIOD: Will expire at ${new Date(now + GRACE_PERIOD).toISOString()}`);

  // Remove from grace period after the specified time
  setTimeout(() => {
    if (graceUsers.get(key) === now) { // Only delete if it's the same timestamp (no newer grace period was set)
      graceUsers.delete(key);
      console.log(`GRACE PERIOD: Removed user ${userId} from grace period for chat ${chatId}`);
    } else {
      console.log(`GRACE PERIOD: Not removing user ${userId} from grace period as it was updated`);
    }
  }, GRACE_PERIOD);
  
  // Note: The database update is handled by storeVerifiedStatus which is called during verification
}

// Function to mark a user as permanently verified (after sending a message)
function markUserAsPermanentlyVerified(userId, chatId) {
  const key = `${userId}:${chatId}`;
  permanentlyVerifiedUsers.set(key, Date.now());

  // This is permanent, but we'll still clean it up after a very long time (30 days)
  // to prevent memory leaks in long-running instances
  setTimeout(() => {
    permanentlyVerifiedUsers.delete(key);
    console.log(`Removed user ${userId} from permanently verified list for chat ${chatId} (cleanup)`);
  }, 30 * 24 * 60 * 60 * 1000); // 30 days

  console.log(`Marked user ${userId} as permanently verified in chat ${chatId}`);
  
  // Update the database to mark as permanently verified
  storeVerifiedStatus(userId, chatId, true).catch(err => {
    console.error("Error storing permanent verified status:", err);
  });
}

// Function to check if a user is permanently verified (now checks database)
async function isPermanentlyVerified(userId, chatId) {
  try {
    // First check in memory for faster response (though this won't persist across serverless invocations)
    const key = `${userId}:${chatId}`;
    const inMemoryVerified = permanentlyVerifiedUsers.has(key);
    
    if (inMemoryVerified) {
      return true;
    }
    
    // Then check the database
    console.log(`Checking database for permanent verification status of user ${userId} in chat ${chatId}`);
    const { data, error } = await supabase
      .from("verified_users")
      .select("*")
      .eq("user_id", userId)
      .eq("chat_id", chatId)
      .eq("permanent", true)
      .single();
    
    if (error && error.code !== "PGRST116") { // PGRST116 is "no rows returned" which is fine
      console.error("Error checking permanent verification status:", error);
      return inMemoryVerified; // Fall back to memory check
    }
    
    const isPermanent = data ? true : false;
    console.log(`Database permanent verification status for user ${userId} in chat ${chatId}: ${isPermanent ? "Permanently Verified" : "Not Permanently Verified"}`);
    
    // If verified in database but not in memory, add to memory
    if (isPermanent && !inMemoryVerified) {
      permanentlyVerifiedUsers.set(key, Date.now());
    }
    
    return isPermanent;
  } catch (error) {
    console.error("Exception checking permanent verification status:", error);
    return false;
  }
}

// Function to mark a user as verified
function markUserAsVerified(userId, chatId) {
  const key = `${userId}:${chatId}`;
  verifiedUsers.set(key, Date.now());

  // Remove from verified list after 24 hours to allow future captchas if needed
  setTimeout(() => {
    verifiedUsers.delete(key);
    console.log(`Removed user ${userId} from verified list for chat ${chatId}`);
  }, 24 * 60 * 60 * 1000); // 24 hours

  console.log(`Marked user ${userId} as verified in chat ${chatId}`);
}

// Function to mark a user as verified in memory only (fallback when database fails)
function markUserAsMemoryVerified(userId, chatId) {
  const key = `${userId}:${chatId}`;
  memoryVerifiedUsers.set(key, Date.now());

  // Keep this record for a long time (7 days) since we can't rely on the database
  setTimeout(() => {
    memoryVerifiedUsers.delete(key);
    console.log(`Removed user ${userId} from memory-verified list for chat ${chatId}`);
  }, 7 * 24 * 60 * 60 * 1000); // 7 days

  console.log(`Marked user ${userId} as memory-verified in chat ${chatId}`);
}

// Function to check if a user is being processed
function isProcessing(userId, chatId) {
  const key = `${userId}:${chatId}`;
  return processingUsers.has(key);
}

// Function to mark a user as being processed
function markAsProcessing(userId, chatId) {
  const key = `${userId}:${chatId}`;
  processingUsers.set(key, Date.now());

  // Remove from processing list after 2 minutes to prevent deadlocks
  setTimeout(() => {
    processingUsers.delete(key);
    console.log(`Removed user ${userId} from processing list for chat ${chatId}`);
  }, 2 * 60 * 1000); // 2 minutes

  console.log(`Marked user ${userId} as being processed in chat ${chatId}`);
}

// Function to mark a user as no longer being processed
function markAsNotProcessing(userId, chatId) {
  const key = `${userId}:${chatId}`;
  processingUsers.delete(key);
  console.log(`Removed user ${userId} from processing list for chat ${chatId}`);
}

// Function to check if a user is currently being restricted
function isBeingRestricted(userId, chatId) {
  const key = `${userId}:${chatId}`;
  return restrictingUsers.has(key);
}

// Function to mark a user as being restricted
function markAsBeingRestricted(userId, chatId) {
  const key = `${userId}:${chatId}`;
  restrictingUsers.set(key, Date.now());

  // Remove from restricting list after 30 seconds to prevent deadlocks
  setTimeout(() => {
    restrictingUsers.delete(key);
    console.log(`Removed user ${userId} from restricting list for chat ${chatId}`);
  }, 30 * 1000); // 30 seconds

  console.log(`Marked user ${userId} as being restricted in chat ${chatId}`);
}

// Function to mark a user as no longer being restricted
function markAsNotBeingRestricted(userId, chatId) {
  const key = `${userId}:${chatId}`;
  restrictingUsers.delete(key);
  console.log(`Removed user ${userId} from restricting list for chat ${chatId}`);
}

// Function to check if a user is currently being unrestricted
function isBeingUnrestricted(userId, chatId) {
  const key = `${userId}:${chatId}`;
  return unrestrictingUsers.has(key);
}

// Function to mark a user as being unrestricted
function markAsBeingUnrestricted(userId, chatId) {
  const key = `${userId}:${chatId}`;
  unrestrictingUsers.set(key, Date.now());

  // Remove from unrestricting list after 30 seconds to prevent deadlocks
  setTimeout(() => {
    unrestrictingUsers.delete(key);
    console.log(`Removed user ${userId} from unrestricting list for chat ${chatId}`);
  }, 30 * 1000); // 30 seconds

  console.log(`Marked user ${userId} as being unrestricted in chat ${chatId}`);
}

// Function to mark a user as no longer being unrestricted
function markAsNotBeingUnrestricted(userId, chatId) {
  const key = `${userId}:${chatId}`;
  unrestrictingUsers.delete(key);
  console.log(`Removed user ${userId} from unrestricting list for chat ${chatId}`);
}

// Function to check if a user has a pending captcha
function hasPendingCaptcha(userId, chatId) {
  const key = `${userId}:${chatId}`;
  return pendingCaptchas.has(key);
}

// Function to mark a user as having a pending captcha
function markAsHavingPendingCaptcha(userId, chatId, captcha) {
  const key = `${userId}:${chatId}`;
  pendingCaptchas.set(key, captcha);

  // Remove from pending captchas list after 1 hour
  setTimeout(() => {
    pendingCaptchas.delete(key);
    console.log(`Removed user ${userId} from pending captchas list for chat ${chatId}`);
  }, 60 * 60 * 1000); // 1 hour

  console.log(`Marked user ${userId} as having pending captcha in chat ${chatId}`);
}

// Function to mark a user as no longer having a pending captcha
function markAsNotHavingPendingCaptcha(userId, chatId) {
  const key = `${userId}:${chatId}`;
  pendingCaptchas.delete(key);
  console.log(`Removed user ${userId} from pending captchas list for chat ${chatId}`);
}

// Function to mark a user as restricted by the bot
function markAsRestrictedByBot(userId, chatId) {
  const key = `${userId}:${chatId}`;
  restrictedByBot.set(key, Date.now());

  // Remove from restricted list after 10 minutes
  setTimeout(() => {
    restrictedByBot.delete(key);
    console.log(`Removed user ${userId} from restricted-by-bot list for chat ${chatId}`);
  }, 10 * 60 * 1000); // 10 minutes

  console.log(`Marked user ${userId} as restricted by bot in chat ${chatId}`);
}

// Function to check if a user was restricted by the bot
function wasRestrictedByBot(userId, chatId) {
  const key = `${userId}:${chatId}`;
  return restrictedByBot.has(key);
}

// Function to mark a user as unrestricted by the bot
function markAsUnrestrictedByBot(userId, chatId) {
  const key = `${userId}:${chatId}`;
  unrestrictedByBot.set(key, Date.now());

  // Keep this record for a longer time (24 hours) to prevent re-restriction loops
  setTimeout(() => {
    unrestrictedByBot.delete(key);
    console.log(`Removed user ${userId} from unrestricted-by-bot list for chat ${chatId}`);
  }, 24 * 60 * 60 * 1000); // 24 hours

  console.log(`Marked user ${userId} as unrestricted by bot in chat ${chatId}`);
}

// Function to check if a user was unrestricted by the bot
function wasUnrestrictedByBot(userId, chatId) {
  const key = `${userId}:${chatId}`;
  return unrestrictedByBot.has(key);
}

// Function to unrestrict a user with multiple approaches
async function unrestrict(api, chatId, userId) {
  console.log(`Attempting to unrestrict user ${userId} in chat ${chatId} using multiple methods`);

  // Check if already being unrestricted to prevent race conditions
  if (isBeingUnrestricted(userId, chatId)) {
    console.log(`User ${userId} is already being unrestricted, skipping duplicate unrestriction`);
    return true;
  }

  try {
    // Mark as being unrestricted to prevent concurrent operations
    markAsBeingUnrestricted(userId, chatId);
    
    // Mark the user as verified BEFORE unrestricting to prevent re-restriction loops
    markUserAsVerified(userId, chatId);
    markUserAsMemoryVerified(userId, chatId);
    markAsUnrestrictedByBot(userId, chatId);
    
    // NEW: Mark user as in grace period
    markUserInGracePeriod(userId, chatId);

    // Store verified status in database but don't wait for it
    storeVerifiedStatus(userId, chatId).catch(err => {
      console.error("Error storing verified status:", err);
      // Continue with unrestriction anyway
    });

    let success = false;
    let retryCount = 0;

    // Keep trying until success or max retries reached
    while (!success && retryCount < MAX_UNRESTRICT_RETRIES) {
      try {
        const timeoutPromise = new Promise((_, reject) => {
          setTimeout(() => reject(new Error('Unrestrict timeout')), UNRESTRICT_TIMEOUT);
        });

        // Try all unrestriction methods in parallel
        const results = await Promise.race([
          timeoutPromise,
          Promise.all([
            // Method 1: Simple permissions
            api.restrictChatMember(chatId, userId, {
              can_send_messages: true,
              can_send_media_messages: true,
              can_send_other_messages: true,
              can_add_web_page_previews: true
            }).catch(e => console.log("Method 1 failed:", e.message)),

            // Method 2: Full permissions object
            api.restrictChatMember(chatId, userId, {
              permissions: {
                can_send_messages: true,
                can_send_media_messages: true,
                can_send_other_messages: true,
                can_add_web_page_previews: true,
                can_send_polls: true,
                can_send_audios: true,
                can_send_documents: true,
                can_send_photos: true,
                can_send_videos: true,
                can_send_video_notes: true,
                can_send_voice_notes: true,
                can_invite_users: true
              }
            }).catch(e => console.log("Method 2 failed:", e.message))
          ])
        ]);

        if (results) {
          success = true;
          console.log(`Successfully unrestricted user ${userId} after ${retryCount + 1} attempts`);
        }
      } catch (error) {
        console.log(`Attempt ${retryCount + 1} failed:`, error.message);
        retryCount++;
        if (retryCount < MAX_UNRESTRICT_RETRIES) {
          await delay(UNRESTRICT_RETRY_DELAY);
        }
      }
    }

    // Mark as no longer being unrestricted
    markAsNotBeingUnrestricted(userId, chatId);
    
    return success;
  } catch (error) {
    console.error("Error in unrestrict function:", error);
    // Mark as no longer being unrestricted
    markAsNotBeingUnrestricted(userId, chatId);
    return false;
  }
}

// Function to restrict a user
async function restrictUser(api, chatId, userId) {
  console.log(`Attempting to restrict user ${userId} in chat ${chatId}`);

  // Check if already being restricted to prevent race conditions
  if (isBeingRestricted(userId, chatId)) {
    console.log(`User ${userId} is already being restricted, skipping`);
    return false;
  }

  // ENHANCED LOGGING: Log all verification statuses for debugging
  console.log(`RESTRICT CHECK: Verification status for user ${userId} in chat ${chatId}:`);
  console.log(`- Permanently verified: ${await isPermanentlyVerified(userId, chatId)}`);
  console.log(`- Recently verified: ${isRecentlyVerified(userId, chatId)}`);
  console.log(`- Unrestricted by bot: ${wasUnrestrictedByBot(userId, chatId)}`);
  console.log(`- Memory verified: ${memoryVerifiedUsers.has(`${userId}:${chatId}`)}`);
  console.log(`- In grace period: ${await isInGracePeriod(userId, chatId)}`);

  // NEW: Check if user is permanently verified
  if (await isPermanentlyVerified(userId, chatId)) {
    console.log(`User ${userId} is permanently verified, not restricting`);
    return false;
  }

  // NEW: Check if user is in grace period
  if (await isInGracePeriod(userId, chatId)) {
    console.log(`GRACE PROTECTION: User ${userId} is in grace period, not restricting`);
    return false;
  }

  // Check if already verified to prevent restricting verified users
  if (isRecentlyVerified(userId, chatId) || wasUnrestrictedByBot(userId, chatId) || memoryVerifiedUsers.has(`${userId}:${chatId}`)) {
    console.log(`User ${userId} is verified, not restricting`);
    return false;
  }

  try {
    // Mark as being restricted to prevent concurrent operations
    markAsBeingRestricted(userId, chatId);
    
    // Mark that this restriction was done by the bot
    markAsRestrictedByBot(userId, chatId);
    
    // Try multiple restriction approaches
    let restrictionSucceeded = false;
    
    // Approach 1: Standard restriction
    try {
      await api.restrictChatMember(chatId, userId, {
        permissions: {
          can_send_messages: false,
          can_send_media_messages: false,
          can_send_other_messages: false,
          can_add_web_page_previews: false
        }
      });
      restrictionSucceeded = true;
      console.log(`Successfully restricted user ${userId} in chat ${chatId} using standard approach`);
    } catch (error) {
      console.error(`Error restricting user ${userId} using standard approach:`, error.message);
    }
    
    // If standard approach failed, try alternative approach
    if (!restrictionSucceeded) {
      try {
        await api.restrictChatMember(chatId, userId, {
          can_send_messages: false,
          can_send_media_messages: false,
          can_send_other_messages: false,
          can_add_web_page_previews: false
        });
        restrictionSucceeded = true;
        console.log(`Successfully restricted user ${userId} in chat ${chatId} using alternative approach`);
      } catch (error) {
        console.error(`Error restricting user ${userId} using alternative approach:`, error.message);
      }
    }
    
    // Mark as no longer being restricted
    markAsNotBeingRestricted(userId, chatId);
    
    return restrictionSucceeded;
  } catch (error) {
    console.error(`Error restricting user ${userId} in chat ${chatId}:`, error);
    // Mark as no longer being restricted
    markAsNotBeingRestricted(userId, chatId);
    return false;
  }
}

// Function to store captcha in database with upsert
async function storeCaptcha(userId, chatId, captcha) {
  console.log(`Attempting to store captcha in database: user_id=${userId}, chat_id=${chatId}, captcha=${captcha}`);

  try {
    // First, try to delete any existing captcha for this user in this chat
    console.log(`Checking for existing captcha for user ${userId} in chat ${chatId}`);
    const { error: deleteError } = await supabase
      .from("captchas")
      .delete()
      .eq("user_id", userId)
      .eq("chat_id", chatId);
    
    if (deleteError) {
      console.error("Error deleting existing captcha:", deleteError);
    } else {
      console.log("Successfully deleted any existing captcha entries");
    }
    
    // Now insert the new captcha
    const captchaData = {
      user_id: userId,
      chat_id: chatId,
      captcha: captcha,
      attempts: 0,
      created_at: new Date().toISOString(),
    };
    
    console.log("Captcha data to insert:", JSON.stringify(captchaData));
    
    const { data, error } = await supabase
      .from("captchas")
      .insert(captchaData);
    
    if (error) {
      console.error("Database error when storing captcha:", error);
      console.error("Error details:", JSON.stringify(error));
      
      // Store in memory as fallback
      markAsHavingPendingCaptcha(userId, chatId, captcha);
      
      return false;
    } else {
      console.log("Captcha stored successfully, response:", JSON.stringify(data));
      
      // Also store in memory for redundancy
      markAsHavingPendingCaptcha(userId, chatId, captcha);
      
      return true;
    }
  } catch (error) {
    console.error("Exception during captcha storage:", error);
    
    // Store in memory as fallback
    markAsHavingPendingCaptcha(userId, chatId, captcha);
    
    return false;
  }
}

// Function to check if a user has a verified status in the database
async function checkVerifiedStatus(userId, chatId) {
  try {
    // First check in memory for faster response
    if (isRecentlyVerified(userId, chatId) || wasUnrestrictedByBot(userId, chatId) || memoryVerifiedUsers.has(`${userId}:${chatId}`) || await isPermanentlyVerified(userId, chatId)) {
      console.log(`User ${userId} is verified in memory for chat ${chatId}`);
      return true;
    }
    
    // Then check the database
    console.log(`Checking database for verified status of user ${userId} in chat ${chatId}`);
    const { data, error } = await supabase
      .from("verified_users")
      .select("*")
      .eq("user_id", userId)
      .eq("chat_id", chatId)
      .single();
    
    if (error && error.code !== "PGRST116") { // PGRST116 is "no rows returned" which is fine
      console.error("Error checking verified status:", error);
      return false;
    }
    
    const isVerified = data ? true : false;
    console.log(`Database verification status for user ${userId} in chat ${chatId}: ${isVerified ? "Verified" : "Not verified"}`);
    
    // If verified in database but not in memory, add to memory
    if (isVerified && !isRecentlyVerified(userId, chatId)) {
      markUserAsVerified(userId, chatId);
    }
    
    return isVerified;
  } catch (error) {
    console.error("Exception checking verified status:", error);
    return false;
  }
}

// Function to mark a user as verified in the database
async function storeVerifiedStatus(userId, chatId, permanent = false) {
  try {
    // First check if the record already exists
    console.log(`Checking if user ${userId} is already verified in chat ${chatId}`);
    const { data: existingData, error: checkError } = await supabase
      .from("verified_users")
      .select("*")
      .eq("user_id", userId)
      .eq("chat_id", chatId);
    
    if (checkError) {
      console.error("Error checking existing verified status:", checkError);
      // Mark as memory-verified as a fallback
      markUserAsMemoryVerified(userId, chatId);
      return false;
    }
    
    // If record exists, update it if needed
    if (existingData && existingData.length > 0) {
      console.log(`User ${userId} already has a verification record in chat ${chatId}`);
      
      // If we're setting permanent and it's not already permanent, update it
      if (permanent && !existingData[0].permanent) {
        console.log(`Updating user ${userId} to permanent verification in chat ${chatId}`);
        
        const { error: updateError } = await supabase
          .from("verified_users")
          .update({ 
            permanent: true,
            verified_at: new Date().toISOString() // Also update the timestamp
          })
          .eq("id", existingData[0].id);
        
        if (updateError) {
          console.error("Error updating to permanent verification:", updateError);
          return false;
        }
        
        console.log(`Updated user ${userId} to permanent verification in chat ${chatId}`);
      } else {
        // Update the verified_at timestamp to extend the grace period
        const { error: updateError } = await supabase
          .from("verified_users")
          .update({ verified_at: new Date().toISOString() })
          .eq("id", existingData[0].id);
        
        if (updateError) {
          console.error("Error updating verification timestamp:", updateError);
        } else {
          console.log(`Updated verification timestamp for user ${userId} in chat ${chatId}`);
        }
      }
      
      return true;
    }
    
    // Otherwise insert a new record
    console.log(`Storing verified status for user ${userId} in chat ${chatId}`);
    
    const { error } = await supabase
      .from("verified_users")
      .insert({
        user_id: userId,
        chat_id: chatId,
        verified_at: new Date().toISOString(),
        permanent: permanent
      })
      .select();
    
    if (error) {
      console.error("Error storing verified status:", error);
      // Mark as memory-verified as a fallback
      markUserAsMemoryVerified(userId, chatId);
      return false;
    }
    
    console.log(`Stored verified status for user ${userId} in chat ${chatId}`);
    return true;
  } catch (error) {
    console.error("Exception storing verified status:", error);
    // Mark as memory-verified as a fallback
    markUserAsMemoryVerified(userId, chatId);
    return false;
  }
}

// Function to handle new members (shared logic between chat_member and message:new_chat_members)
async function handleNewMember(ctx, userId, chatId, firstName, username) {
  console.log(`Handling new member: ${firstName} (${userId}) in chat ${chatId}`);

  // ENHANCED LOGGING: Log all verification statuses for debugging
  console.log(`Verification status for user ${userId} in chat ${chatId}:`);
  console.log(`- Permanently verified: ${await isPermanentlyVerified(userId, chatId)}`);
  console.log(`- Recently verified: ${isRecentlyVerified(userId, chatId)}`);
  console.log(`- Unrestricted by bot: ${wasUnrestrictedByBot(userId, chatId)}`);
  console.log(`- Memory verified: ${memoryVerifiedUsers.has(`${userId}:${chatId}`)}`);
  console.log(`- In grace period: ${await isInGracePeriod(userId, chatId)}`);

  // NEW: Check if user is permanently verified
  if (await isPermanentlyVerified(userId, chatId)) {
    console.log(`User ${userId} is permanently verified, not generating captcha`);
    
    // Ensure they're unrestricted
    await unrestrict(ctx.api, chatId, userId);
    return;
  }

  // CRITICAL CHECK: If this user was recently verified or unrestricted by the bot, don't restrict them
  if (isRecentlyVerified(userId, chatId) || wasUnrestrictedByBot(userId, chatId) || memoryVerifiedUsers.has(`${userId}:${chatId}`)) {
    console.log(`User ${userId} is already verified, not generating captcha`);
    
    // Ensure they're unrestricted
    await unrestrict(ctx.api, chatId, userId);
    return;
  }

  // NEW: Check if user is in grace period
  if (await isInGracePeriod(userId, chatId)) {
    console.log(`GRACE PROTECTION: User ${userId} is in grace period, not generating captcha`);
    
    // Ensure they're unrestricted
    await unrestrict(ctx.api, chatId, userId);
    return;
  }

  // Check if this user is already verified in the database
  const isVerified = await checkVerifiedStatus(userId, chatId);
  if (isVerified) {
    console.log(`User ${userId} is already verified in database, not generating captcha`);
    
    // Ensure they're unrestricted
    await unrestrict(ctx.api, chatId, userId);
    return;
  }

  // Check if the user already has a captcha in memory
  if (hasPendingCaptcha(userId, chatId)) {
    console.log(`User ${userId} already has a pending captcha in memory, not generating a new one`);
    return;
  }

  // Check if the user already has a captcha in the database
  const { data, error } = await supabase
    .from("captchas")
    .select("*")
    .eq("user_id", userId)
    .eq("chat_id", chatId)
    .limit(1);

  if (!error && data && data.length > 0) {
    console.log(`User ${userId} already has a captcha in database, not generating a new one`);
    
    // Store in memory for redundancy
    markAsHavingPendingCaptcha(userId, chatId, data[0].captcha);
    
    return;
  }

  // Generate a new captcha
  const captcha = generateCaptcha();
  console.log(`Generated captcha: ${captcha} for user ${userId}`);

  // Restrict the user until they solve the captcha
  try {
    // Mark the user as being processed to prevent concurrent operations
    markAsProcessing(userId, chatId);
    
    // Restrict the user
    const restrictSuccess = await restrictUser(ctx.api, chatId, userId);
    
    if (!restrictSuccess) {
      console.log(`Failed to restrict user ${userId}, but will still generate captcha`);
      // Continue anyway, as the user might already be restricted by another admin
    }
    
    // Store the captcha in the database
    const stored = await storeCaptcha(userId, chatId, captcha);
    
    // Get chat title
    let chatTitle = "the group";
    try {
      const chatInfo = await ctx.api.getChat(chatId);
      if (chatInfo && chatInfo.title) {
        chatTitle = chatInfo.title;
      }
    } catch (chatError) {
      console.error("Error getting chat info:", chatError);
    }
    
    // NEW APPROACH: Send a message in the group tagging the user to check their DMs
    console.log("Sending DM notification message");
    await ctx.api.sendMessage(
      chatId,
      addAttribution(
        `Welcome, ${firstName}! @${username || firstName}\n\nPlease check your direct messages from me to complete the captcha verification and gain access to ${chatTitle}.`
      ),
    );
    
    // Send the captcha directly to the user in a DM
    try {
      await ctx.api.sendMessage(
        userId,
        addAttribution(
          `👋 Hello ${firstName}!\n\nTo gain access to ${chatTitle}, please reply to this message with the following captcha code:\n\n${captcha}`
        )
      );
      console.log(`Sent captcha DM to user ${userId}`);
    } catch (dmError) {
      console.error("Error sending DM to user:", dmError);
      
      // If we can't send a DM, fall back to the old approach of sending the captcha in the group
      await ctx.api.sendMessage(
        chatId,
        addAttribution(
          `${firstName}, I couldn't send you a direct message. Please click on my username (@${ctx.me.username}) and start a chat with me, then send me this captcha code:\n\n${captcha}`
        ),
      );
    }
    
    console.log("Captcha process initiated successfully");
    
    // Mark user as no longer being processed
    markAsNotProcessing(userId, chatId);
  } catch (error) {
    console.error("Error handling new member:", error);
    // Mark user as no longer being processed
    markAsNotProcessing(userId, chatId);
  }
}

// Function to verify captcha and unrestrict user
async function verifyCaptchaAndUnrestrict(ctx, userId, groupChatId, captchaRecord) {
  if (isProcessing(userId, groupChatId)) {
    console.log(`User ${userId} is already being processed, ignoring duplicate verification`);
    await ctx.reply("Your captcha is already being processed. Please wait a moment.");
    return false;
  }

  markAsProcessing(userId, groupChatId);

  try {
    // Get chat info to get the title
    let chatTitle = "the group";
    try {
      const chatInfo = await ctx.api.getChat(groupChatId);
      if (chatInfo && chatInfo.title) {
        chatTitle = chatInfo.title;
      }
    } catch (chatError) {
      console.error("Error getting chat info:", chatError);
    }

    // First, notify the user that verification was successful
    await ctx.reply(addAttribution(`✅ Captcha verified successfully! You will gain access to ${chatTitle} in a few seconds.`));

    // Mark the user as verified BEFORE removing restrictions
    markUserAsVerified(userId, groupChatId);
    markUserAsMemoryVerified(userId, groupChatId);
    markAsUnrestrictedByBot(userId, groupChatId);
    
    // NEW: Mark user as in grace period
    markUserInGracePeriod(userId, groupChatId);
    console.log(`VERIFICATION: User ${userId} marked as in grace period for chat ${groupChatId}`);

    // Remove from pending captchas
    markAsNotHavingPendingCaptcha(userId, groupChatId);

    // Delete the captcha from the database BEFORE unrestricting
    if (captchaRecord && captchaRecord.id) {
      await supabase.from("captchas").delete().eq("id", captchaRecord.id);
    }

    // Store verified status in database but don't wait for it
    storeVerifiedStatus(userId, groupChatId).catch(err => {
      console.error("Error storing verified status:", err);
      // Continue anyway since we have memory verification
    });

    // Now remove restrictions with retries
    console.log(`Removing restrictions for user ${userId} in chat ${groupChatId}`);
    const success = await unrestrict(ctx.api, groupChatId, userId);

    if (success) {
      console.log(`Restrictions removed for user ${userId}`);
      
      // Send success messages
      await ctx.reply(addAttribution(`✅ You now have full access to ${chatTitle}! Please send a message in the group within the next 60 seconds to confirm your membership.`));
      
      try {
        await ctx.api.sendMessage(
          groupChatId,
          addAttribution(`✅ @${ctx.from.username || ctx.from.first_name} has verified their captcha and can now participate in the group. Please send a message within 60 seconds to confirm your membership.`)
        );
      } catch (msgError) {
        console.error("Error sending group success message:", msgError);
        // Continue anyway since the user is already unrestricted
      }

      return true;
    } else {
      console.error("Failed to remove restrictions");
      await ctx.reply("There was an error removing restrictions. Please contact the group admin.");
      return false;
    }
  } catch (error) {
    console.error("Error verifying captcha:", error);
    await ctx.reply("There was an error verifying your captcha. Please contact the group admin.");
    return false;
  } finally {
    markAsNotProcessing(userId, groupChatId);
  }
}

// Handle text messages (captcha verification) - FIXED TO IGNORE /start COMMAND
bot.on("message:text", async (ctx) => {
  try {
    // Safely check if required properties exist
    if (!ctx.message || !ctx.message.text || !ctx.from || !ctx.chat) {
      console.log("Missing required message:text properties");
      return;
    }
    
    const userId = ctx.from.id;
    const userInput = ctx.message.text.trim();
    
    console.log(`Received text message: "${userInput}" from user ${userId}`);
    
    // IMPORTANT FIX: Skip processing if this is a /start command
    if (userInput === "/start") {
      console.log("Ignoring /start command in message:text handler");
      return;
    }
    
    // Check if this is a private chat
    if (ctx.chat.type === "private") {
      console.log("Message received in private chat, checking for captchas");
      
      // Check database for captchas for this user
      console.log(`Looking for captchas for user ID: ${userId}`);
      
      // Use RLS bypass for the query
      const { data, error } = await supabase
        .from("captchas")
        .select("*")
        .eq("user_id", userId)
        .order("created_at", { ascending: false });
      
      if (error) {
        console.error("Database error when checking captcha:", error);
        console.error("Error details:", JSON.stringify(error));
        await ctx.reply("Sorry, there was an error checking your captcha. Please try again later.");
        return;
      }
      
      console.log(`Query returned ${data ? data.length : 0} captchas`);
      if (data && data.length > 0) {
        console.log("Captchas found:", JSON.stringify(data));
        
        let captchaVerified = false;
        let groupChatId = null;
        let captchaRecord = null;
        
        // Check if any of the captchas match the user input
        for (const record of data) {
          console.log(`Comparing user input "${userInput}" with captcha "${record.captcha}"`);
          if (userInput === record.captcha) {
            captchaVerified = true;
            groupChatId = record.chat_id;
            captchaRecord = record;
            break;
          }
        }
        
        if (captchaVerified && captchaRecord) {
          await verifyCaptchaAndUnrestrict(ctx, userId, groupChatId, captchaRecord);
          return;
        } else {
          // Incorrect captcha
          console.log(`Incorrect captcha for user ${userId}`);
          
          // Find the most recent captcha to update attempts
          if (data.length > 0) {
            const mostRecentCaptcha = data[0];
            
            // Update attempts in database
            const attempts = (mostRecentCaptcha.attempts || 0) + 1;
            await supabase
              .from("captchas")
              .update({ attempts: attempts })
              .eq("id", mostRecentCaptcha.id);
            
            if (attempts >= 3) {
              // Too many failed attempts, kick the user
              console.log(`Too many failed attempts for user ${userId}, kicking from chat ${mostRecentCaptcha.chat_id}`);
              try {
                await ctx.api.banChatMember(mostRecentCaptcha.chat_id, userId);
                await ctx.api.unbanChatMember(mostRecentCaptcha.chat_id, userId); // Unban immediately to allow rejoining
                console.log(`User ${userId} kicked and unbanned`);
                
                await ctx.reply(addAttribution(`❌ Too many failed attempts. You have been removed from the group. You can rejoin and try again if you wish.`));
                
                // Delete the captcha from the database
                console.log(`Deleting captcha for user ${userId}`);
                await supabase.from("captchas").delete().eq("id", mostRecentCaptcha.id);
                
                // Remove from pending captchas
                markAsNotHavingPendingCaptcha(userId, mostRecentCaptcha.chat_id);
              } catch (error) {
                console.error("Error kicking user:", error);
                await ctx.reply("There was an error processing your captcha. Please contact the group admin.");
              }
            } else {
              // Allow more attempts
              console.log(`Sending incorrect captcha message, ${3 - attempts} attempts left`);
              await ctx.reply(
                addAttribution(`❌ Incorrect captcha. Please try again. You have ${3 - attempts} attempts left.`)
              );
            }
          } else {
            // This shouldn't happen, but just in case
            await ctx.reply(addAttribution(`❌ Incorrect captcha. Please try again.`));
          }
          return;
        }
      } else {
        console.log("No captchas found in database for user", userId);
        await ctx.reply("I don't have any pending captchas for you. If you were recently added to a group, please try again or contact the group admin.");
        return;
      }
    }
    
    // If not a private chat, handle as before (for group messages)
    const chatId = ctx.chat.id;

    // NEW: Check if user is in grace period and mark as permanently verified if they send a message
    if (await isInGracePeriod(userId, chatId)) {
      console.log(`GRACE PERIOD MESSAGE: User ${userId} sent a message during grace period, marking as permanently verified`);
      markUserAsPermanentlyVerified(userId, chatId);
      
      // Also store in database for persistence
      storeVerifiedStatus(userId, chatId, true).catch(err => {
        console.error("Error storing permanent verified status:", err);
      });
      
      // No need to check for captcha since they're already verified
      return;
    }

    // Get the captcha from the database
    console.log(`Checking for captcha for user ${userId} in chat ${chatId}`);
    const { data, error } = await supabase
      .from("captchas")
      .select("*")
      .eq("user_id", userId)
      .eq("chat_id", chatId)
      .order("created_at", { ascending: false })
      .limit(1);
    
    if (error) {
      console.error("Database error when checking captcha:", error);
      return;
    }
    
    if (!data || data.length === 0) {
      console.log(`No captcha found for user ${userId}`);
      return;
    }
    
    console.log(`Found captcha: ${data[0].captcha} for user ${userId}`);
    const captcha = data[0].captcha;
    
    console.log(`Comparing user input "${userInput}" with captcha "${captcha}"`);
    if (userInput === captcha) {
      await verifyCaptchaAndUnrestrict(ctx, userId, chatId, data[0]);
    } else {
      // Incorrect captcha
      console.log(`Incorrect captcha for user ${userId}`);
      
      // Update attempts in database
      const attempts = (data[0].attempts || 0) + 1;
      await supabase
        .from("captchas")
        .update({ attempts: attempts })
        .eq("id", data[0].id);
      
      console.log(`Attempt ${attempts} of 3`);
      
      if (attempts >= 3) {
        // Too many failed attempts, kick the user
        console.log(`Too many failed attempts for user ${userId}, kicking`);
        try {
          await ctx.api.banChatMember(chatId, userId);
          await ctx.api.unbanChatMember(chatId, userId); // Unban immediately to allow rejoining
          console.log(`User ${userId} kicked and unbanned`);
          
          await ctx.reply(addAttribution(`❌ Too many failed attempts. Please rejoin the group and try again.`));
          console.log("Kick message sent");
          
          // Delete the captcha from the database
          console.log(`Deleting captcha for user ${userId}`);
          await supabase.from("captchas").delete().eq("id", data[0].id);
          console.log("Captcha deleted from database");
          
          // Remove from pending captchas
          markAsNotHavingPendingCaptcha(userId, chatId);
        } catch (error) {
          console.error("Error kicking user:", error);
        }
      } else {
        // Allow more attempts
        console.log(`Sending incorrect captcha message, ${3 - attempts} attempts left`);
        await ctx.reply(
          addAttribution(`❌ Incorrect captcha. Please try again. You have ${3 - attempts} attempts left.`),
        );
        console.log("Incorrect captcha message sent");
      }
    }
  } catch (error) {
    console.error("Error in message:text handler:", error);
  }
});

// Add a simple message handler to test if the bot is working
bot.on("message", async (ctx) => {
  try {
    console.log("Received a message in general handler");

    // Safely check if text exists
    if (ctx.message && ctx.message.text) {
      console.log(`Message text in general handler: ${ctx.message.text}`);
    } else {
      console.log("Message has no text");
    }

    // NEW: Check if user is in grace period and mark as permanently verified if they send a message
    if (ctx.from && ctx.chat && ctx.chat.type !== "private" && await isInGracePeriod(ctx.from.id, ctx.chat.id)) {
      console.log(`GRACE PERIOD MESSAGE: User ${ctx.from.id} sent a message during grace period, marking as permanently verified`);
      markUserAsPermanentlyVerified(ctx.from.id, ctx.chat.id);
      
      // Also store in database for persistence
      storeVerifiedStatus(ctx.from.id, ctx.chat.id, true).catch(err => {
        console.error("Error storing permanent verified status:", err);
      });
    }

    // Only reply with the test message if it's not already handled by the message:text handler
    // and it's a private chat with no pending captchas
    if (ctx.chat && ctx.chat.type === "private") {
      // Skip if this is a /start command or text message (already handled)
      if (ctx.message && ctx.message.text) {
        if (ctx.message.text.trim() === "/start" || ctx.message.text.trim().startsWith("/")) {
          return; // Skip command messages, they're handled by command handlers
        }
        // Skip text messages as they're handled by the message:text handler
        return;
      }
      
      // Check if there are pending captchas for this user
      const userId = ctx.from.id;
      const { data, error } = await supabase
        .from("captchas")
        .select("captcha")
        .eq("user_id", userId)
        .limit(1);
      
      if (error || !data || data.length === 0) {
        // No captchas found, send the welcome message
        await ctx.reply(addAttribution("I received your message! This confirms the webhook is working."));
      }
    }
  } catch (error) {
    console.error("Error in message handler:", error);
  }
});

// Handle new chat members via chat_member updates - ENHANCED TO RESPECT GRACE PERIOD
bot.on("chat_member", async (ctx) => {
  try {
    console.log("chat_member event received");
    console.log("Full chat_member update:", JSON.stringify(ctx.update));
    
    // Safely check if required properties exist
    if (!ctx.chatMember || !ctx.chatMember.new_chat_member || !ctx.chatMember.new_chat_member.user) {
      console.log("Missing required chat_member properties");
      return;
    }
    
    const member = ctx.chatMember.new_chat_member;
    const oldMember = ctx.chatMember.old_chat_member;
    
    // Safely check if me exists
    if (!ctx.me) {
      console.log("ctx.me is undefined");
      return;
    }

    // Skip if it's the bot itself
    if (member.user.id === ctx.me.id) {
      console.log("Ignoring chat_member event for the bot itself");
      return;
    }
    
    // Safely check if chat exists
    if (!ctx.chat) {
      console.log("ctx.chat is undefined");
      return;
    }
    
    const userId = member.user.id;
    const chatId = ctx.chat.id;
    const chatTitle = ctx.chat.title || "the group";
    
    console.log(`Processing chat_member event for user ${userId} with status ${member.status}`);
    
    // ENHANCED LOGGING: Log all verification statuses for debugging
    console.log(`Verification status for user ${userId} in chat ${chatId}:`);
    console.log(`- Permanently verified: ${await isPermanentlyVerified(userId, chatId)}`);
    console.log(`- Recently verified: ${isRecentlyVerified(userId, chatId)}`);
    console.log(`- Unrestricted by bot: ${wasUnrestrictedByBot(userId, chatId)}`);
    console.log(`- Memory verified: ${memoryVerifiedUsers.has(`${userId}:${chatId}`)}`);
    console.log(`- In grace period: ${await isInGracePeriod(userId, chatId)}`);
    
    // NEW: Check if user is permanently verified
    if (await isPermanentlyVerified(userId, chatId)) {
      console.log(`User ${userId} is permanently verified, ignoring restriction`);
      
      // If they're restricted, try to unrestrict them immediately
      if (member.status === "restricted" && (!member.can_send_messages || !member.can_send_media_messages)) {
        console.log(`User ${userId} is permanently verified but restricted, unrestricting`);
        await unrestrict(ctx.api, chatId, userId);
      }
      
      return;
    }
    
    // NEW: Check if user is in grace period
    if (await isInGracePeriod(userId, chatId)) {
      console.log(`GRACE PROTECTION: User ${userId} is in grace period, ignoring restriction`);
      
      // If they're restricted, try to unrestrict them immediately
      if (member.status === "restricted" && (!member.can_send_messages || !member.can_send_media_messages)) {
        console.log(`User ${userId} is in grace period but restricted, unrestricting`);
        await unrestrict(ctx.api, chatId, userId);
      }
      
      return;
    }
    
    // CRITICAL FIX: Check if this user was recently verified or unrestricted by the bot
    // This is the key to preventing re-restriction loops
    if (isRecentlyVerified(userId, chatId) || wasUnrestrictedByBot(userId, chatId) || memoryVerifiedUsers.has(`${userId}:${chatId}`)) {
      console.log(`User ${userId} was recently verified or unrestricted, ignoring restriction and unrestricting again`);
      
      // If they're restricted, try to unrestrict them again immediately
      if (member.status === "restricted" && (!member.can_send_messages || !member.can_send_media_messages)) {
        console.log(`User ${userId} is verified but restricted, unrestricting again`);
        await unrestrict(ctx.api, chatId, userId);
      }
      
      // IMPORTANT: Return early to prevent further processing
      return;
    }
    
    // Check if the user was just restricted (either by this bot or another admin)
    if (member.status === "restricted" && 
        (!oldMember || oldMember.status !== "restricted" || 
         (oldMember.can_send_messages && !member.can_send_messages))) {
      
      // Check if user is already verified in the database
      const isVerified = await checkVerifiedStatus(userId, chatId);
      if (isVerified) {
        console.log(`User ${userId} is verified in database, unrestricting without captcha`);
        
        // Try to unrestrict the user
        await unrestrict(ctx.api, chatId, userId);
        return;
      }
      
      // Check if the user already has a captcha in memory
      if (hasPendingCaptcha(userId, chatId)) {
        console.log(`User ${userId} already has a pending captcha in memory, not generating a new one`);
        return;
      }
      
      // Check if the user already has a captcha in the database
      const { data, error } = await supabase
        .from("captchas")
        .select("*")
        .eq("user_id", userId)
        .eq("chat_id", chatId)
        .limit(1);
      
      if (!error && data && data.length > 0) {
        console.log(`User ${userId} already has a captcha, not generating a new one`);
        
        // Store in memory for redundancy
        markAsHavingPendingCaptcha(userId, chatId, data[0].captcha);
        
        return;
      }
      
      console.log(`User ${userId} was restricted, generating captcha`);
      
      // Generate a new captcha
      const captcha = generateCaptcha();
      console.log(`Generated captcha: ${captcha} for user ${userId}`);
      
      // Store the captcha in the database with attempts field - using the new function
      const stored = await storeCaptcha(userId, chatId, captcha);
      
      // NEW APPROACH: Send a message in the group tagging the user to check their DMs
      console.log("Sending DM notification message");
      await ctx.api.sendMessage(
        chatId,
        addAttribution(
          `Welcome, ${member.user.first_name}! @${member.user.username || member.user.first_name}\n\nPlease check your direct messages from me to complete the captcha verification and gain access to ${chatTitle}.`
        ),
      );
      
      // Send the captcha directly to the user in a DM
      try {
        await ctx.api.sendMessage(
          userId,
          addAttribution(
            `👋 Hello ${member.user.first_name}!\n\nTo gain access to ${chatTitle}, please reply to this message with the following captcha code:\n\n${captcha}`
          )
        );
        console.log(`Sent captcha DM to user ${userId}`);
      } catch (dmError) {
        console.error("Error sending DM to user:", dmError);
        
        // If we can't send a DM, fall back to the old approach of sending the captcha in the group
        await ctx.api.sendMessage(
          chatId,
          addAttribution(
            `${member.user.first_name}, I couldn't send you a direct message. Please click on my username (@${ctx.me.username}) and start a chat with me, then send me this captcha code:\n\n${captcha}`
          ),
        );
      }
    } 
    // Also handle new members joining
    else if (member.status === "member" && (!oldMember || oldMember.status !== "member")) {
      // Use the shared handler for new members
      await handleNewMember(ctx, userId, chatId, member.user.first_name, member.user.username);
    } else {
      console.log(`Ignoring chat_member event: status=${member.status}, old_status=${oldMember ? oldMember.status : 'unknown'}`);
    }
  } catch (error) {
    console.error("Error in chat_member handler:", error);
  }
});

// Handle new chat members via message updates - ENHANCED WITH DEBUGGING
bot.on("message:new_chat_members", async (ctx) => {
  try {
    console.log("new_chat_members event received");
    console.log("Full new_chat_members update:", JSON.stringify(ctx.update));
    
    // Safely check if required properties exist
    if (!ctx.message || !ctx.message.new_chat_members || !ctx.chat || !ctx.me) {
      console.log("Missing required new_chat_members properties");
      return;
    }
      {
      console.log("Missing required new_chat_members properties");
      return;
    }
    
    const newMembers = ctx.message.new_chat_members;
    
    for (const member of newMembers) {
      // Skip if it's the bot itself
      if (member.id === ctx.me.id) {
        console.log("Bot was added to a group, skipping captcha");
        continue;
      }
      
      console.log(`Processing new member: ${member.first_name} (${member.id})`);
      
      // Use the shared handler for new members
      await handleNewMember(ctx, member.id, ctx.chat.id, member.first_name, member.username);
    }
  } catch (error) {
    console.error("Error in new_chat_members handler:", error);
  }
});

// Handle the /start command - FIXED TO PROPERLY HANDLE START COMMAND IN PRIVATE CHATS
bot.command("start", async (ctx) => {
  try {
    console.log("Received /start command");
    
    // Check if this user has pending captchas before showing the welcome message
    if (ctx.chat && ctx.chat.type === "private" && ctx.from) {
      const userId = ctx.from.id;
      
      // Check for pending captchas
      const { data, error } = await supabase
        .from("captchas")
        .select("*")
        .eq("user_id", userId)
        .order("created_at", { ascending: false });
      
      if (!error && data && data.length > 0) {
        // User has pending captchas, show them the captcha info
        const captchaInfo = data.map(c => {
          return `Chat: ${c.chat_id}\nCaptcha: ${c.captcha}`;
        }).join("\n\n");
        
        await ctx.reply(
          addAttribution(
            `👋 Hello! I have pending captchas for you:\n\n${captchaInfo}\n\nPlease send the captcha code to verify yourself.`
          )
        );
        return;
      }
    }
    
    // No pending captchas or not in private chat, show the standard welcome message
    await ctx.reply(
      addAttribution(
        "👋 Hello! I'm a captcha bot that helps protect groups from spam.\n\nAdd me to a group and grant me admin privileges to get started."
      ),
    );
    console.log("Sent start message");
  } catch (error) {
    console.error("Error in start command handler:", error);
  }
});

// Add debug command
bot.command("debug", async (ctx) => {
  try {
    console.log("Received /debug command");

    // Safely check if chat exists
    if (!ctx.chat) {
      console.log("ctx.chat is undefined in debug command");
      return;
    }

    const chatId = ctx.chat.id;
    const botInfo = await ctx.api.getMe();
    console.log(`Bot info: ${JSON.stringify(botInfo)}`);

    const chatMember = await ctx.api.getChatMember(chatId, botInfo.id);
    console.log(`Chat member info: ${JSON.stringify(chatMember)}`);

    // Check for pending captchas for this user
    let captchasInfo = "";
    if (ctx.from) {
      const { data, error } = await supabase
        .from("captchas")
        .select("*")
        .eq("user_id", ctx.from.id);
      
      if (!error && data && data.length > 0) {
        captchasInfo = `\nPending Captchas: ${data.length}\n${data.map(c => `Chat ID: ${c.chat_id}, Captcha: ${c.captcha}, Attempts: ${c.attempts || 0}`).join("\n")}`;
      } else {
        captchasInfo = "\nNo pending captchas found for you.";
      }
    }

    // Check verified status
    let verifiedInfo = "";
    if (ctx.from) {
      const isVerifiedInDb = await checkVerifiedStatus(ctx.from.id, chatId);
      const isRecentlyVerifiedInMemory = isRecentlyVerified(ctx.from.id, chatId);
      const isUnrestrictedByBot = wasUnrestrictedByBot(ctx.from.id, chatId);
      const isMemoryVerified = memoryVerifiedUsers.has(`${ctx.from.id}:${chatId}`);
      const isPermanentVerified = await isPermanentlyVerified(ctx.from.id, chatId);
      const isGracePeriod = await isInGracePeriod(ctx.from.id, chatId);
      
      verifiedInfo = `\nVerified Status: ${isVerifiedInDb ? "✅ Verified in DB" : "❌ Not Verified in DB"}`;
      verifiedInfo += `\nRecently Verified (in-memory): ${isRecentlyVerifiedInMemory ? "✅ Yes" : "❌ No"}`;
      verifiedInfo += `\nMemory-only Verified: ${isMemoryVerified ? "✅ Yes" : "❌ No"}`;
      verifiedInfo += `\nUnrestricted By Bot: ${isUnrestrictedByBot ? "✅ Yes" : "❌ No"}`;
      verifiedInfo += `\nPermanently Verified: ${isPermanentVerified ? "✅ Yes" : "❌ No"}`;
      verifiedInfo += `\nIn Grace Period: ${isGracePeriod ? "✅ Yes" : "❌ No"}`;
      
      // Check if being processed
      const isBeingProcessed = isProcessing(ctx.from.id, chatId);
      verifiedInfo += `\nCurrently Being Processed: ${isBeingProcessed ? "✅ Yes" : "❌ No"}`;
      
      // Check if restricted by bot
      const isRestrictedByBot = wasRestrictedByBot(ctx.from.id, chatId);
      verifiedInfo += `\nRestricted By Bot: ${isRestrictedByBot ? "✅ Yes" : "❌ No"}`;
    }

    // Test RLS bypass
    const testResult = await testRLS();

    await ctx.reply(
      addAttribution(`Debug Info:
Bot ID: ${botInfo.id}
Bot Username: ${botInfo.username}
Chat ID: ${chatId}
Bot Status in Chat: ${chatMember.status}
Bot Permissions: ${JSON.stringify(chatMember)}${captchasInfo}${verifiedInfo}

RLS Test: ${testResult}
      `),
    );
    console.log("Sent debug info");
  } catch (error) {
    console.error("Error in debug command:", error);
    if (ctx.chat) {
      await ctx.reply("Error retrieving debug info: " + error.message);
    }
  }
});

// Add a command to check bot permissions in a group
bot.command("checkbot", async (ctx) => {
  try {
    console.log("Received /checkbot command");
    
    // Only process in group chats
    if (!ctx.chat || (ctx.chat.type !== "group" && ctx.chat.type !== "supergroup")) {
      await ctx.reply("This command only works in groups.");
      return;
    }
    
    const chatId = ctx.chat.id;
    const botInfo = await ctx.api.getMe();
    const botMember = await ctx.api.getChatMember(chatId, botInfo.id);
    
    console.log(`Bot permissions in chat ${chatId}:`, JSON.stringify(botMember));
    
    let permissionText = "Bot Permissions in this group:\n";
    
    if (botMember.status === "administrator") {
      permissionText += "✅ Bot is an administrator\n\n";
      
      // Check specific permissions
      const permissions = [
        ["can_restrict_members", "Restrict members"],
        ["can_delete_messages", "Delete messages"],
        ["can_invite_users", "Invite users"]
      ];
      
      for (const [perm, label] of permissions) {
        permissionText += `${botMember[perm] ? "✅" : "❌"} ${label}\n`;
      }
      
      if (!botMember.can_restrict_members) {
        permissionText += "\n⚠️ The bot needs the 'Restrict members' permission to function properly!";
      }
    } else {
      permissionText += "❌ Bot is NOT an administrator!\n\nPlease make the bot an administrator with the 'Restrict members' permission.";
    }
    
    await ctx.reply(addAttribution(permissionText));
    console.log("Sent permissions info");
  } catch (error) {
    console.error("Error in checkbot command:", error);
    if (ctx.chat) {
      await ctx.reply("Error checking permissions: " + error.message);
    }
  }
});

// Add a command to manually unrestrict a user
bot.command("unrestrict", async (ctx) => {
  try {
    console.log("Received /unrestrict command");
    
    // Only process in group chats
    if (!ctx.chat || (ctx.chat.type !== "group" && ctx.chat.type !== "supergroup")) {
      await ctx.reply("This command only works in groups.");
      return;
    }
    
    // Check if the command is a reply to a message
    if (!ctx.message || !ctx.message.reply_to_message) {
      await ctx.reply("Please use this command as a reply to a message from the user you want to unrestrict.");
      return;
    }
    
    const targetUserId = ctx.message.reply_to_message.from.id;
    const chatId = ctx.chat.id;
    
    console.log(`Attempting to manually unrestrict user ${targetUserId} in chat ${chatId}`);
    
    // Check if the user is an admin
    const senderMember = await ctx.api.getChatMember(chatId, ctx.from.id);
    if (senderMember.status !== "administrator" && senderMember.status !== "creator") {
      await ctx.reply("Only administrators can use this command.");
      return;
    }
    
    // Try to unrestrict the user
    try {
      await ctx.reply("Attempting to unrestrict user...");
      
      // Mark as permanently verified
      markUserAsPermanentlyVerified(targetUserId, chatId);
      
      const success = await unrestrict(ctx.api, chatId, targetUserId);
      
      if (success) {
        await ctx.reply("✅ User has been unrestricted successfully and marked as permanently verified!");
      } else {
        await ctx.reply("❌ Failed to unrestrict user. Please check bot permissions.");
      }
    } catch (error) {
      console.error("Error in unrestrict command:", error);
      await ctx.reply(`Error: ${error.message}`);
    }
  } catch (error) {
    console.error("Error in unrestrict command:", error);
    if (ctx.chat) {
      await ctx.reply("Error processing command: " + error.message);
    }
  }
});

// Add a command to clear captchas for a user
bot.command("clearcaptcha", async (ctx) => {
  try {
    console.log("Received /clearcaptcha command");
    
    // Only process in group chats
    if (!ctx.chat || (ctx.chat.type !== "group" && ctx.chat.type !== "supergroup")) {
      await ctx.reply("This command only works in groups.");
      return;
    }
    
    // Check if the command is a reply to a message
    if (!ctx.message || !ctx.message.reply_to_message) {
      await ctx.reply("Please use this command as a reply to a message from the user whose captcha you want to clear.");
      return;
    }
    
    const targetUserId = ctx.message.reply_to_message.from.id;
    const chatId = ctx.chat.id;
    
    console.log(`Attempting to clear captcha for user ${targetUserId} in chat ${chatId}`);
    
    // Check if the user is an admin
    const senderMember = await ctx.api.getChatMember(chatId, ctx.from.id);
    if (senderMember.status !== "administrator" && senderMember.status !== "creator") {
      await ctx.reply("Only administrators can use this command.");
      return;
    }
    
    // Delete captcha from database
    const { error } = await supabase
      .from("captchas")
      .delete()
      .eq("user_id", targetUserId)
      .eq("chat_id", chatId);
    
    // Also remove from memory
    markAsNotHavingPendingCaptcha(targetUserId, chatId);
    
    if (error) {
      console.error("Error clearing captcha:", error);
      await ctx.reply("❌ Failed to clear captcha: " + error.message);
    } else {
      await ctx.reply("✅ Captcha cleared successfully!");
    }
  } catch (error) {
    console.error("Error in clearcaptcha command:", error);
    if (ctx.chat) {
      await ctx.reply("Error processing command: " + error.message);
    }
  }
});

// Test RLS bypass function
async function testRLS() {
  try {
    console.log("Testing RLS bypass");
    
    // Use a random ID to avoid duplicate key errors
    const randomId = Math.floor(Math.random() * 1000000) + 1000000;
    
    // Test insert
    const testData = {
      user_id: randomId,
      chat_id: randomId,
      captcha: "RLSTEST",
      attempts: 0,
      created_at: new Date().toISOString()
    };
    
    // First check if the test data already exists
    const { data: existingData, error: checkError } = await supabase
      .from("captchas")
      .select("id")
      .eq("user_id", randomId)
      .eq("chat_id", randomId);
      
    if (checkError) {
      console.error("RLS test check failed:", checkError);
      return `Check failed: ${checkError.message}`;
    }
    
    // If test data already exists, delete it first
    if (existingData && existingData.length > 0) {
      const { error: deleteError } = await supabase
        .from("captchas")
        .delete()
        .eq("user_id", randomId)
        .eq("chat_id", randomId);
        
      if (deleteError) {
        console.error("RLS test cleanup failed:", deleteError);
        return `Cleanup failed: ${deleteError.message}`;
      }
    }
    
    // Now insert the test data
    const { data: insertData, error: insertError } = await supabase
      .from("captchas")
      .insert(testData);
    
    if (insertError) {
      console.error("RLS test insert failed:", insertError);
      return `Failed: ${insertError.message}`;
    }
    
    console.log("RLS test insert succeeded");
    
    // Clean up
    const { error: deleteError } = await supabase
      .from("captchas")
      .delete()
      .eq("user_id", randomId)
      .eq("chat_id", randomId);
    
    if (deleteError) {
      console.error("RLS test cleanup failed:", deleteError);
      return "Insert succeeded but cleanup failed";
    }
    
    return "Success - RLS bypass working";
  } catch (error) {
    console.error("Error in RLS test:", error);
    return `Error: ${error.message}`;
  }
}

// Handle errors
bot.catch((err) => {
  try {
    const ctx = err.ctx;
    console.error(`Error while handling update ${ctx.update.update_id}:`);
    const e = err.error;
    if (e instanceof Error) {
      console.error("Error:", e.message);
    } else {
      console.error("Unknown error:", e);
    }
  } catch (error) {
    console.error("Error in error handler:", error);
  }
});

// Handle webhook requests
module.exports = async (req, res) => {
  // Handle CORS preflight requests
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "authorization, x-client-info, apikey, content-type");
    res.status(200).send("OK");
    return;
  }

  try {
    console.log("Received webhook request");

    // Test database connection
    console.log("Testing database connection");
    try {
      const { data, error } = await supabase.from("captchas").select("count").limit(1);
      if (error) {
        console.error("Database connection test failed:", error);
      } else {
        console.log("Database connection test successful:", data);
      }
    } catch (dbError) {
      console.error("Exception during database test:", dbError);
    }

    // Test RLS bypass
    console.log("Testing RLS bypass in webhook handler");
    const rlsTestResult = await testRLS();
    console.log("RLS test result:", rlsTestResult);

    // Parse the update safely
    let update;
    try {
      update = req.body;
      console.log("Update payload:", JSON.stringify(update));
    } catch (error) {
      console.error("Error parsing update JSON:", error);
      res.status(400).send("Bad Request: Invalid JSON");
      return;
    }

    // Check update type for debugging
    if (update.chat_member) {
      console.log("Detected chat_member update");
      if (update.chat_member.new_chat_member) {
        console.log("New member status:", update.chat_member.new_chat_member.status);
        if (update.chat_member.new_chat_member.user) {
          console.log("User info:", JSON.stringify(update.chat_member.new_chat_member.user));
        }
      }
    }

    if (update.message && update.message.new_chat_members && update.message.new_chat_members.length > 0) {
      console.log("Detected new_chat_members via message");
      console.log("New members:", JSON.stringify(update.message.new_chat_members));
    }

    // Initialize the bot before handling updates
    try {
      // This is the key fix - initialize the bot before handling updates
      await bot.init();
      console.log("Bot initialized successfully");
      
      await bot.handleUpdate(update);
      console.log("Update processed successfully");
    } catch (error) {
      console.error("Error in bot.handleUpdate:", error);
    }

    res.status(200).send("OK");
  } catch (err) {
    console.error("Error processing update:", err);
    res.status(500).send("Internal Server Error");
  }
};
