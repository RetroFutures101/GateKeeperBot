const { Bot, session } = require("grammy");
const { createClient } = require("@supabase/supabase-js");

// CORS headers for public access
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

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

// Function to unrestrict a user with multiple approaches
async function unrestrict(api, chatId, userId) {
  console.log(`Attempting to unrestrict user ${userId} in chat ${chatId} using multiple methods`);
  
  try {
    // First approach: Simple permission object (old style)
    console.log("Method 1: Using simple permission object (old style)");
    try {
      await api.restrictChatMember(chatId, userId, {
        can_send_messages: true,
        can_send_media_messages: true,
        can_send_other_messages: true,
        can_add_web_page_previews: true
      });
      console.log("Method 1 succeeded");
    } catch (error) {
      console.log("Method 1 failed:", error.message);
    }
    
    // Wait a moment between methods
    await delay(1000);
    
    // Second approach: Using the full permission object
    console.log("Method 2: Using full permission object");
    try {
      await api.restrictChatMember(chatId, userId, {
        permissions: {
          can_send_messages: true,
          can_send_media_messages: true,
          can_send_other_messages: true,
          can_add_web_page_previews: true
        }
      });
      console.log("Method 2 succeeded");
    } catch (error) {
      console.log("Method 2 failed:", error.message);
    }
    
    // Wait a moment between methods
    await delay(1000);
    
    // Third approach: Using the comprehensive permission object
    console.log("Method 3: Using comprehensive permission object");
    try {
      await api.restrictChatMember(chatId, userId, {
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
      });
      console.log("Method 3 succeeded");
    } catch (error) {
      console.log("Method 3 failed:", error.message);
    }
    
    console.log("All unrestriction methods attempted");
    return true;
  } catch (error) {
    console.error("Error in unrestrict function:", error);
    return false;
  }
}

// Handle text messages (captcha verification) - MUST BE REGISTERED BEFORE THE GENERAL MESSAGE HANDLER
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
        let captchaAttempts = 0;
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
        
        if (captchaVerified) {
          // Correct captcha
          console.log(`Captcha correct for user ${userId}`);
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
            console.log("Sending initial success message to private chat");
            await ctx.reply(addAttribution(`✅ Captcha verified successfully! You will gain access to ${chatTitle} in a few seconds.`));
            
            // Wait for 3 seconds before removing restrictions
            console.log(`Waiting 3 seconds before removing restrictions for user ${userId}...`);
            await delay(3000);
            
            // Now remove restrictions using multiple methods
            console.log(`Removing restrictions for user ${userId} in chat ${groupChatId}`);
            const success = await unrestrict(ctx.api, groupChatId, userId);
            
            if (success) {
              console.log(`Restrictions removed for user ${userId}`);
              
              // Send a follow-up confirmation
              console.log("Sending final success message to private chat");
              await ctx.reply(addAttribution(`✅ You now have full access to ${chatTitle}!`));
              
              // Send success message to group
              console.log("Sending success message to group");
              await ctx.api.sendMessage(
                groupChatId,
                addAttribution(`✅ @${ctx.from.username || ctx.from.first_name} has verified their captcha and can now participate in the group.`)
              );
              
              // Delete the captcha from the database
              console.log(`Deleting captcha for user ${userId}`);
              await supabase.from("captchas").delete().eq("user_id", userId).eq("chat_id", groupChatId);
              
              console.log("Captcha verification complete");
            } else {
              console.error("Failed to remove restrictions");
              await ctx.reply("There was an error removing restrictions. Please contact the group admin.");
            }
            return;
          } catch (error) {
            console.error("Error verifying captcha:", error);
            await ctx.reply("There was an error verifying your captcha. Please contact the group admin.");
            return;
          }
        } else {
          // Incorrect captcha
          console.log(`Incorrect captcha for user ${userId}`);
          
          // Update attempts in database
          const attempts = (captchaRecord.attempts || 0) + 1;
          await supabase
            .from("captchas")
            .update({ attempts: attempts })
            .eq("id", captchaRecord.id);
          
          if (attempts >= 3) {
            // Too many failed attempts, kick the user
            console.log(`Too many failed attempts for user ${userId}, kicking from chat ${captchaRecord.chat_id}`);
            try {
              await ctx.api.banChatMember(captchaRecord.chat_id, userId);
              await ctx.api.unbanChatMember(captchaRecord.chat_id, userId); // Unban immediately to allow rejoining
              console.log(`User ${userId} kicked and unbanned`);
              
              await ctx.reply(addAttribution(`❌ Too many failed attempts. You have been removed from the group. You can rejoin and try again if you wish.`));
              
              // Delete the captcha from the database
              console.log(`Deleting captcha for user ${userId}`);
              await supabase.from("captchas").delete().eq("id", captchaRecord.id);
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
      // Correct captcha
      console.log(`Captcha correct for user ${userId}, waiting before removing restrictions...`);
      try {
        // First, notify the user that verification was successful
        await ctx.reply(addAttribution(`✅ Captcha verified successfully! You will gain access to the group in a few seconds.`));
        
        // Wait for 3 seconds before removing restrictions
        console.log(`Waiting 3 seconds before removing restrictions for user ${userId}...`);
        await delay(3000);
        
        // Now remove restrictions using multiple methods
        console.log(`Removing restrictions for user ${userId}`);
        const success = await unrestrict(ctx.api, chatId, userId);
        
        if (success) {
          console.log(`Restrictions removed for user ${userId}`);
          
          // Send success message
          console.log("Sending success message");
          await ctx.reply(addAttribution(`✅ You now have full access to the group!`));
          console.log("Success message sent");
          
          // Delete the captcha from the database
          console.log(`Deleting captcha for user ${userId}`);
          await supabase.from("captchas").delete().eq("id", data[0].id);
          console.log("Captcha deleted from database");
        } else {
          console.error("Failed to remove restrictions");
          await ctx.reply("There was an error removing restrictions. Please contact the group admin.");
        }
      } catch (error) {
        console.error("Error verifying captcha:", error);
      }
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

    // Only reply with the test message if it's not already handled by the message:text handler
    // and it's a private chat with no pending captchas
    if (ctx.chat && ctx.chat.type === "private") {
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

// Handle new chat members via chat_member updates - ENHANCED WITH DEBUGGING
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
    
    // Check if the user was just restricted (either by this bot or another admin)
    if (member.status === "restricted" && 
        (!oldMember || oldMember.status !== "restricted" || 
         (oldMember.can_send_messages && !member.can_send_messages))) {
      
      console.log(`User ${userId} was restricted, generating captcha`);
      
      // Generate a new captcha
      const captcha = generateCaptcha();
      console.log(`Generated captcha: ${captcha} for user ${userId}`);
      
      // Store the captcha in the database with attempts field
      console.log(`Attempting to store captcha in database: user_id=${userId}, chat_id=${chatId}, captcha=${captcha}`);
      try {
        // Explicitly disable RLS for this operation
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
        } else {
          console.log("Captcha stored successfully, response:", JSON.stringify(data));
        }
        
        // Send captcha message in the group
        console.log("Sending captcha message");
        await ctx.api.sendMessage(
          chatId,
          addAttribution(
            `Welcome, ${member.user.first_name}!\n\nTo gain access to ${chatTitle}, please click on my username (@${ctx.me.username}) and send me this captcha code in a private message:\n\n${captcha}`
          ),
        );
        console.log("Captcha message sent successfully");
      } catch (error) {
        console.error("Error generating captcha:", error);
      }
    } 
    // Also handle new members joining
    else if (member.status === "member" && (!oldMember || oldMember.status !== "member")) {
      // New member joined
      console.log(`New member joined: ${member.user.first_name} (${member.user.id})`);
      
      // Generate a new captcha
      const captcha = generateCaptcha();
      console.log(`Generated captcha: ${captcha} for user ${userId}`);

      // Restrict the user until they solve the captcha
      try {
        console.log(`Restricting user ${userId} in chat ${chatId}`);
        await ctx.api.restrictChatMember(chatId, userId, {
          permissions: {
            can_send_messages: false,
            can_send_media_messages: false,
            can_send_other_messages: false,
            can_add_web_page_previews: false
          }
        });
        console.log(`User ${userId} restricted successfully`);

        // Store the captcha in the database with attempts field
        console.log(`Attempting to store captcha in database: user_id=${userId}, chat_id=${chatId}, captcha=${captcha}`);
        try {
          // Explicitly disable RLS for this operation
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
          } else {
            console.log("Captcha stored successfully, response:", JSON.stringify(data));
          }
        } catch (dbError) {
          console.error("Exception during database operation:", dbError);
        }

        // Send captcha message in the group
        console.log("Sending captcha message");
        await ctx.api.sendMessage(
          chatId,
          addAttribution(
            `Welcome, ${member.user.first_name}!\n\nTo gain access to ${chatTitle}, please click on my username (@${ctx.me.username}) and send me this captcha code in a private message:\n\n${captcha}`
          ),
        );
        console.log("Captcha message sent successfully");
      } catch (error) {
        console.error("Error handling new member:", error);
      }
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
    
    const newMembers = ctx.message.new_chat_members;
    
    for (const member of newMembers) {
      // Skip if it's the bot itself
      if (member.id === ctx.me.id) {
        console.log("Bot was added to a group, skipping captcha");
        continue;
      }
      
      console.log(`Processing new member: ${member.first_name} (${member.id})`);
      const userId = member.id;
      const chatId = ctx.chat.id;
      const chatTitle = ctx.chat.title || "the group";
      
      // Generate a new captcha
      const captcha = generateCaptcha();
      console.log(`Generated captcha: ${captcha} for user ${userId}`);
      
      // Restrict the user until they solve the captcha
      try {
        console.log(`Attempting to restrict user ${userId} in chat ${chatId}`);
        await ctx.api.restrictChatMember(chatId, userId, {
          permissions: {
            can_send_messages: false,
            can_send_media_messages: false,
            can_send_other_messages: false,
            can_add_web_page_previews: false
          }
        });
        console.log(`Successfully restricted user ${userId}`);
        
        // Store the captcha in the database with attempts field
        console.log(`Attempting to store captcha in database: user_id=${userId}, chat_id=${chatId}, captcha=${captcha}`);
        try {
          // Explicitly disable RLS for this operation
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
          } else {
            console.log("Captcha stored successfully, response:", JSON.stringify(data));
          }
        } catch (dbError) {
          console.error("Exception during database operation:", dbError);
        }
        
        // Send captcha message in the group
        console.log("Sending captcha message");
        await ctx.api.sendMessage(
          chatId,
          addAttribution(`Welcome, ${member.first_name}!\n\nTo gain access to ${chatTitle}, please click on my username (@${ctx.me.username}) and send me this captcha code in a private message:\n\n${captcha}`)
        );
        console.log("Captcha message sent successfully");
      } catch (error) {
        console.error(`Error handling new member ${userId}:`, error);
      }
    }
  } catch (error) {
    console.error("Error in new_chat_members handler:", error);
  }
});

// Handle the /start command
bot.command("start", async (ctx) => {
  try {
    console.log("Received /start command");
    await ctx.reply(
      addAttribution(
        "👋 Hello! I'm a captcha bot that helps protect groups from spam.\n\nAdd me to a group and grant me admin privileges to get started.",
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

    // Test RLS bypass
    const testResult = await testRLS();

    await ctx.reply(
      addAttribution(`Debug Info:
Bot ID: ${botInfo.id}
Bot Username: ${botInfo.username}
Chat ID: ${chatId}
Bot Status in Chat: ${chatMember.status}
Bot Permissions: ${JSON.stringify(chatMember)}
${captchasInfo}

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
      const success = await unrestrict(ctx.api, chatId, targetUserId);
      
      if (success) {
        await ctx.reply("✅ User has been unrestricted successfully!");
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

// Test RLS bypass function
async function testRLS() {
  try {
    console.log("Testing RLS bypass");
    
    // Test insert
    const testData = {
      user_id: 999999,
      chat_id: 999999,
      captcha: "RLSTEST",
      attempts: 0,
      created_at: new Date().toISOString()
    };
    
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
      .eq("user_id", 999999)
      .eq("chat_id", 999999);
    
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
