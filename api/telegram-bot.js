const { Bot, session } = require("grammy");
const { createClient } = require("@supabase/supabase-js");

// CORS headers for public access
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Initialize Supabase client
const supabaseUrl = process.env.SUPABASE_URL || "";
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const supabase = createClient(supabaseUrl, supabaseKey);

// Initialize Telegram bot
const botToken = process.env.TELEGRAM_BOT_TOKEN || "";
const bot = new Bot(botToken);

// Log bot initialization
console.log(`Bot initialized with token: ${botToken ? "✓ Token exists" : "✗ No token found"}`);
console.log(`Supabase initialized with URL: ${supabaseUrl ? "✓ URL exists" : "✗ No URL found"}`);

// Map to store pending captchas for faster access
const pendingCaptchas = new Map();

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

// Add a simple message handler to test if the bot is working
bot.on("message", async (ctx) => {
  try {
    console.log("Received a message");

    // Safely check if text exists
    if (ctx.message && ctx.message.text) {
      console.log(`Message text: ${ctx.message.text}`);
    } else {
      console.log("Message has no text");
    }

    // Safely check chat type
    if (ctx.chat && ctx.chat.type === "private") {
      await ctx.reply(addAttribution("I received your message! This confirms the webhook is working."));
    }
  } catch (error) {
    console.error("Error in message handler:", error);
  }
});

// Handle new chat members via chat_member updates
bot.on("chat_member", async (ctx) => {
  try {
    console.log("chat_member event received");
    
    // Safely check if required properties exist
    if (!ctx.chatMember || !ctx.chatMember.new_chat_member || !ctx.chatMember.new_chat_member.user) {
      console.log("Missing required chat_member properties");
      return;
    }
    
    const member = ctx.chatMember.new_chat_member;
    
    // Safely check if me exists
    if (!ctx.me) {
      console.log("ctx.me is undefined");
      return;
    }

    // Only process if a new user joined and it's not the bot itself
    if (member.status === "member" && member.user.id !== ctx.me.id) {
      console.log(`New member joined: ${member.user.first_name} (${member.user.id})`);
      
      // Safely check if chat exists
      if (!ctx.chat) {
        console.log("ctx.chat is undefined");
        return;
      }
      
      const userId = member.user.id;
      const chatId = ctx.chat.id;
      const chatTitle = ctx.chat.title || "the group";

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
            can_add_web_page_previews: false,
          },
        });
        console.log(`User ${userId} restricted successfully`);

        // Store the captcha in the database
        console.log("Storing captcha in database");
        const { data, error } = await supabase.from("captchas").insert({
          user_id: userId,
          chat_id: chatId,
          captcha: captcha,
          created_at: new Date().toISOString(),
        });
        
        if (error) {
          console.error("Database error:", error);
        } else {
          console.log("Captcha stored successfully");
        }
        
        // Store in memory for quick access
        pendingCaptchas.set(`${userId}:${chatId}`, {
          captcha,
          chatTitle,
          attempts: 0,
          timestamp: Date.now()
        });

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
      console.log(`Ignoring chat_member event: status=${member.status}, is_bot=${member.user.id === ctx.me.id}`);
    }
  } catch (error) {
    console.error("Error in chat_member handler:", error);
  }
});

// Handle new chat members via message updates
bot.on("message:new_chat_members", async (ctx) => {
  try {
    console.log("new_chat_members event received");
    
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
            can_add_web_page_previews: false,
          },
        });
        console.log(`Successfully restricted user ${userId}`);
        
        // Store the captcha in the database
        console.log("Storing captcha in database");
        const { data, error } = await supabase
          .from("captchas")
          .insert({
            user_id: userId,
            chat_id: chatId,
            captcha: captcha,
            created_at: new Date().toISOString(),
          });
        
        if (error) {
          console.error("Database error:", error);
        } else {
          console.log("Captcha stored successfully");
        }
        
        // Store in memory for quick access
        pendingCaptchas.set(`${userId}:${chatId}`, {
          captcha,
          chatTitle,
          attempts: 0,
          timestamp: Date.now()
        });
        
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

// Handle text messages (captcha verification)
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
      console.log("Message received in private chat");
      
      // Check all pending captchas for this user
      let captchaFound = false;
      let captchaVerified = false;
      let groupChatId = null;
      let pendingCaptchaInfo = null;
      
      // First check memory cache for faster response
      for (const [key, info] of pendingCaptchas.entries()) {
        const [pendingUserId, pendingChatId] = key.split(':');
        
        if (parseInt(pendingUserId) === userId) {
          captchaFound = true;
          groupChatId = parseInt(pendingChatId);
          pendingCaptchaInfo = info;
          
          console.log(`Found pending captcha in memory: ${info.captcha} for user ${userId} in chat ${groupChatId}`);
          
          if (userInput === info.captcha) {
            captchaVerified = true;
            break;
          } else {
            // Increment attempts
            info.attempts++;
            console.log(`Incorrect captcha attempt ${info.attempts} of 3`);
            
            if (info.attempts >= 3) {
              // Too many failed attempts
              break;
            }
          }
        }
      }
      
      // If not found in memory, check database
      if (!captchaFound) {
        console.log("Checking database for captchas");
        const { data, error } = await supabase
          .from("captchas")
          .select("captcha, chat_id")
          .eq("user_id", userId)
          .order("created_at", { ascending: false });
        
        if (error) {
          console.error("Database error when checking captcha:", error);
          await ctx.reply("Sorry, there was an error checking your captcha. Please try again later.");
          return;
        }
        
        if (data && data.length > 0) {
          captchaFound = true;
          groupChatId = data[0].chat_id;
          
          console.log(`Found captcha in database: ${data[0].captcha} for user ${userId} in chat ${groupChatId}`);
          
          // Add to memory cache
          if (!pendingCaptchas.has(`${userId}:${groupChatId}`)) {
            pendingCaptchas.set(`${userId}:${groupChatId}`, {
              captcha: data[0].captcha,
              chatTitle: "the group", // We don't have the title from DB
              attempts: 0,
              timestamp: Date.now()
            });
            pendingCaptchaInfo = pendingCaptchas.get(`${userId}:${groupChatId}`);
          }
          
          if (userInput === data[0].captcha) {
            captchaVerified = true;
          } else {
            // Increment attempts
            pendingCaptchaInfo.attempts++;
            console.log(`Incorrect captcha attempt ${pendingCaptchaInfo.attempts} of 3`);
            
            if (pendingCaptchaInfo.attempts >= 3) {
              // Too many failed attempts
            }
          }
        }
      }
      
      if (!captchaFound) {
        console.log("No captcha found for user");
        await ctx.reply("I don't have any pending captchas for you. If you were recently added to a group, please try again or contact the group admin.");
        return;
      }
      
      if (captchaVerified) {
        // Correct captcha
        console.log(`Captcha correct for user ${userId}`);
        try {
          // Allow the user to send messages in the group
          console.log(`Removing restrictions for user ${userId} in chat ${groupChatId}`);
          await ctx.api.restrictChatMember(groupChatId, userId, {
            permissions: {
              can_send_messages: true,
              can_send_media_messages: true,
              can_send_other_messages: true,
              can_add_web_page_previews: true,
            },
          });
          console.log(`Restrictions removed for user ${userId}`);
          
          // Send success message to private chat
          console.log("Sending success message to private chat");
          await ctx.reply(addAttribution(`✅ Captcha verified successfully! You now have access to ${pendingCaptchaInfo.chatTitle}.`));
          
          // Send success message to group
          console.log("Sending success message to group");
          await ctx.api.sendMessage(
            groupChatId,
            addAttribution(`✅ @${ctx.from.username || ctx.from.first_name} has verified their captcha and can now participate in the group.`)
          );
          
          // Delete the captcha from the database
          console.log(`Deleting captcha for user ${userId}`);
          await supabase.from("captchas").delete().eq("user_id", userId).eq("chat_id", groupChatId);
          
          // Remove from memory cache
          pendingCaptchas.delete(`${userId}:${groupChatId}`);
          
          console.log("Captcha verification complete");
        } catch (error) {
          console.error("Error verifying captcha:", error);
          await ctx.reply("There was an error verifying your captcha. Please contact the group admin.");
        }
      } else {
        // Incorrect captcha
        console.log(`Incorrect captcha for user ${userId}`);
        
        if (pendingCaptchaInfo.attempts >= 3) {
          // Too many failed attempts, kick the user
          console.log(`Too many failed attempts for user ${userId}, kicking from chat ${groupChatId}`);
          try {
            await ctx.api.banChatMember(groupChatId, userId);
            await ctx.api.unbanChatMember(groupChatId, userId); // Unban immediately to allow rejoining
            console.log(`User ${userId} kicked and unbanned`);
            
            await ctx.reply(addAttribution(`❌ Too many failed attempts. You have been removed from the group. You can rejoin and try again if you wish.`));
            
            // Delete the captcha from the database
            console.log(`Deleting captcha for user ${userId}`);
            await supabase.from("captchas").delete().eq("user_id", userId).eq("chat_id", groupChatId);
            
            // Remove from memory cache
            pendingCaptchas.delete(`${userId}:${groupChatId}`);
          } catch (error) {
            console.error("Error kicking user:", error);
            await ctx.reply("There was an error processing your captcha. Please contact the group admin.");
          }
        } else {
          // Allow more attempts
          console.log(`Sending incorrect captcha message, ${3 - pendingCaptchaInfo.attempts} attempts left`);
          await ctx.reply(
            addAttribution(`❌ Incorrect captcha. Please try again. You have ${3 - pendingCaptchaInfo.attempts} attempts left.`)
          );
        }
      }
      return;
    }
    
    // If not a private chat, handle as before (for group messages)
    const chatId = ctx.chat.id;

    // Get the captcha from the database
    console.log(`Checking for captcha for user ${userId} in chat ${chatId}`);
    const { data, error } = await supabase
      .from("captchas")
      .select("captcha")
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
      console.log(`Captcha correct for user ${userId}`);
      try {
        // Allow the user to send messages
        console.log(`Removing restrictions for user ${userId}`);
        await ctx.api.restrictChatMember(chatId, userId, {
          permissions: {
            can_send_messages: true,
            can_send_media_messages: true,
            can_send_other_messages: true,
            can_add_web_page_previews: true,
          },
        });
        console.log(`Restrictions removed for user ${userId}`);
        
        // Send success message
        console.log("Sending success message");
        await ctx.reply(addAttribution(`✅ Captcha verified successfully! Welcome to the group.`));
        console.log("Success message sent");
        
        // Delete the captcha from the database
        console.log(`Deleting captcha for user ${userId}`);
        await supabase.from("captchas").delete().eq("user_id", userId).eq("chat_id", chatId);
        console.log("Captcha deleted from database");
      } catch (error) {
        console.error("Error verifying captcha:", error);
      }
    } else {
      // Incorrect captcha
      console.log(`Incorrect captcha for user ${userId}`);
      ctx.session.attempts++;
      console.log(`Attempt ${ctx.session.attempts} of 3`);
      
      if (ctx.session.attempts >= 3) {
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
          await supabase.from("captchas").delete().eq("user_id", userId).eq("chat_id", chatId);
          console.log("Captcha deleted from database");
        } catch (error) {
          console.error("Error kicking user:", error);
        }
      } else {
        // Allow more attempts
        console.log(`Sending incorrect captcha message, ${3 - ctx.session.attempts} attempts left`);
        await ctx.reply(
          addAttribution(`❌ Incorrect captcha. Please try again. You have ${3 - ctx.session.attempts} attempts left.`),
        );
        console.log("Incorrect captcha message sent");
      }
    }
  } catch (error) {
    console.error("Error in message:text handler:", error);
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

    await ctx.reply(
      addAttribution(`Debug Info:
Bot ID: ${botInfo.id}
Bot Username: ${botInfo.username}
Chat ID: ${chatId}
Bot Status in Chat: ${chatMember.status}
Bot Permissions: ${JSON.stringify(chatMember)}
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

    // Handle the update with error catching
    try {
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
