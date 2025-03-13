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
      
      // ADDITIONAL CHECK: If this restriction was done by our bot, don't process it again
      if (wasRestrictedByBot(userId, chatId)) {
        console.log(`User ${userId} was restricted by our bot, not generating a new captcha`);
        return;
      }
      
      // Check if user is already verified in the database
      const isVerified = await checkVerifiedStatus(userId, chatId);
      if (isVerified) {
        console.log(`User ${userId} is verified in database, unrestricting without captcha`);
        
        // Try to unrestrict the user
        await unrestrict(ctx.api, chatId, userId);
        return;
      }
      
      // Check if the user already has a captcha
      const { data, error } = await supabase
        .from("captchas")
        .select("*")
        .eq("user_id", userId)
        .eq("chat_id", chatId)
        .limit(1);
      
      if (!error && data && data.length > 0) {
        console.log(`User ${userId} already has a captcha, not generating a new one`);
        return;
      }
      
      console.log(`User ${userId} was restricted, generating captcha`);
      
      // Generate a new captcha
      const captcha = generateCaptcha();
      console.log(`Generated captcha: ${captcha} for user ${userId}`);
      
      // Store the captcha in the database with attempts field - using the new function
      const stored = await storeCaptcha(userId, chatId, captcha);
      
      if (stored) {
        // Send captcha message in the group
        console.log("Sending captcha message");
        await ctx.api.sendMessage(
          chatId,
          addAttribution(
            `Welcome, ${member.user.first_name}!\n\nTo gain access to ${chatTitle}, please click on my username (@${ctx.me.username}) and send me this captcha code in a private message:\n\n${captcha}`
          ),
        );
        console.log("Captcha message sent successfully");
      } else {
        console.error("Failed to store captcha, not sending message");
      }
    } 
    // Also handle new members joining
    else if (member.status === "member" && (!oldMember || oldMember.status !== "member")) {
      // New member joined
      console.log(`New member joined: ${member.user.first_name} (${member.user.id})`);
      
      // CRITICAL CHECK: If this user was recently verified or unrestricted by the bot, don't restrict them
      if (isRecentlyVerified(userId, chatId) || wasUnrestrictedByBot(userId, chatId) || memoryVerifiedUsers.has(`${userId}:${chatId}`)) {
        console.log(`User ${userId} is already verified, not generating captcha`);
        return;
      }
      
      // Check if this user is already verified
      const isVerified = await checkVerifiedStatus(userId, chatId);
      if (isVerified) {
        console.log(`User ${userId} is already verified, not generating captcha`);
        return;
      }
      
      // Check if the user already has a captcha
      const { data, error } = await supabase
        .from("captchas")
        .select("*")
        .eq("user_id", userId)
        .eq("chat_id", chatId)
        .limit(1);
      
      if (!error && data && data.length > 0) {
        console.log(`User ${userId} already has a captcha, not generating a new one`);
        return;
      }
      
      // Generate a new captcha
      const captcha = generateCaptcha();
      console.log(`Generated captcha: ${captcha} for user ${userId}`);

      // Restrict the user until they solve the captcha
      try {
        console.log(`Restricting user ${userId} in chat ${chatId}`);
        
        // Mark the user as being processed to prevent concurrent operations
        markAsProcessing(userId, chatId);
        
        // Mark that this restriction was done by the bot
        markAsRestrictedByBot(userId, chatId);
        
        await ctx.api.restrictChatMember(chatId, userId, {
          permissions: {
            can_send_messages: false,
            can_send_media_messages: false,
            can_send_other_messages: false,
            can_add_web_page_previews: false
          }
        });
        console.log(`User ${userId} restricted successfully`);

        // Store the captcha in the database with attempts field - using the new function
        const stored = await storeCaptcha(userId, chatId, captcha);
        
        if (stored) {
          // Send captcha message in the group
          console.log("Sending captcha message");
          await ctx.api.sendMessage(
            chatId,
            addAttribution(
              `Welcome, ${member.user.first_name}!\n\nTo gain access to ${chatTitle}, please click on my username (@${ctx.me.username}) and send me this captcha code in a private message:\n\n${captcha}`
            ),
          );
          console.log("Captcha message sent successfully");
        } else {
          console.error("Failed to store captcha, not sending message");
        }
        
        // Mark user as no longer being processed
        markAsNotProcessing(userId, chatId);
      } catch (error) {
        console.error("Error handling new member:", error);
        // Mark user as no longer being processed
        markAsNotProcessing(userId, chatId);
      }
    } else {
      console.log(`Ignoring chat_member event: status=${member.status}, old_status=${oldMember ? oldMember.status : 'unknown'}`);
    }
  } catch (error) {
    console.error("Error in chat_member handler:", error);
  }
});
