const logger = require("../utils/logger").child({ module: "invitations" });
const express = require("express");
const router = express.Router();
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const { Resend } = require("resend");
const { auth, generateToken } = require("../middleware/auth");
const Invitation = require("../models/Invitation");
const User = require("../models/User");
const Account = require("../models/Account");
const AccountUser = require("../models/AccountUser");

const resend = new Resend(process.env.RESEND_API_KEY);

// POST / — create and send an invitation (admin only)
router.post("/", auth, async (req, res) => {
  try {
    // Only admins (role 0) can send invitations
    if (!req.user || req.user.role !== 0) {
      return res.status(403).json({ error: "Admin access required" });
    }

    const { email, first_name, last_name, type, ghl, account_id, role, has_outbound, has_research } = req.body;

    if (!email) {
      return res.status(400).json({ error: "email is required" });
    }
    if (!type || !["client", "team_member"].includes(type)) {
      return res.status(400).json({ error: "type must be 'client' or 'team_member'" });
    }

    // Type-specific validations
    if (type === "client") {
      const existingUser = await User.findOne({ email }).lean();
      if (existingUser) {
        return res.status(409).json({ error: "A user with this email already exists" });
      }
    }

    if (type === "team_member") {
      if (!account_id) {
        return res.status(400).json({ error: "account_id is required for team member invitations" });
      }
      const existingMembership = await AccountUser.findOne({
        account_id,
        user_id: { $in: await User.find({ email }).distinct("_id") },
      }).lean();
      if (existingMembership) {
        return res.status(409).json({ error: "User is already a member of this account" });
      }
    }

    // Generate invitation token and expiry
    const token = crypto.randomBytes(32).toString("hex");
    const expires_at = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    const invitation = await Invitation.create({
      email,
      first_name: first_name || null,
      last_name: last_name || null,
      token,
      type,
      ghl: ghl || null,
      account_id: account_id || null,
      role: role != null ? role : 2,
      has_outbound: has_outbound || false,
      has_research: has_research != null ? has_research : true,
      status: "pending",
      expires_at,
      invited_by: req.user.userId || null,
    });

    // Send invitation email
    const inviteUrl = `${process.env.FRONTEND_URL}/invite/${token}`;
    try {
      await resend.emails.send({
        from: "Quddify <onboarding@resend.dev>",
        to: email,
        subject: "You've been invited to Quddify",
        html: `
          <!DOCTYPE html>
          <html>
          <head><meta charset="utf-8"></head>
          <body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background-color:#f4f4f5;">
            <table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 20px;">
              <tr>
                <td align="center">
                  <table width="480" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;padding:40px;">
                    <tr>
                      <td>
                        <h1 style="margin:0 0 16px;font-size:24px;color:#111827;">You've been invited to Quddify</h1>
                        <p style="margin:0 0 24px;font-size:16px;color:#4b5563;line-height:1.5;">
                          You've been invited to join Quddify. Click the button below to set up your account.
                        </p>
                        <a href="${inviteUrl}" style="display:inline-block;background-color:#2563eb;color:#ffffff;font-size:16px;font-weight:600;text-decoration:none;padding:12px 24px;border-radius:6px;">
                          Accept Invitation
                        </a>
                        <p style="margin:24px 0 0;font-size:13px;color:#9ca3af;">
                          This invitation expires in 7 days. If you didn't expect this email, you can safely ignore it.
                        </p>
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>
            </table>
          </body>
          </html>
        `,
      });
    } catch (emailErr) {
      logger.error({ err: emailErr }, "Failed to send invitation email");
      // Don't fail the request — the invitation is created, email delivery is best-effort
    }

    logger.info({ invitationId: invitation._id, email, type }, "Invitation created");
    res.status(201).json({
      _id: invitation._id,
      email: invitation.email,
      type: invitation.type,
      status: invitation.status,
      created: invitation.createdAt,
    });
  } catch (err) {
    logger.error({ err }, "Failed to create invitation");
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /:token — validate an invitation (public)
router.get("/:token", async (req, res) => {
  try {
    const invitation = await Invitation.findOne({
      token: req.params.token,
      status: "pending",
      expires_at: { $gt: new Date() },
    }).lean();

    if (!invitation) {
      return res.status(404).json({ error: "Invitation not found or expired" });
    }

    res.json({
      email: invitation.email,
      first_name: invitation.first_name,
      last_name: invitation.last_name,
      type: invitation.type,
    });
  } catch (err) {
    logger.error({ err }, "Failed to fetch invitation");
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /:token/accept — accept an invitation (public)
router.post("/:token/accept", async (req, res) => {
  try {
    const invitation = await Invitation.findOne({
      token: req.params.token,
      status: "pending",
      expires_at: { $gt: new Date() },
    });

    if (!invitation) {
      return res.status(404).json({ error: "Invitation not found or expired" });
    }

    const { password, first_name, last_name } = req.body;
    if (!password || password.length < 6) {
      return res.status(400).json({ error: "Password is required and must be at least 6 characters" });
    }

    const finalFirstName = first_name || invitation.first_name;
    const finalLastName = last_name || invitation.last_name;
    const displayName = [finalFirstName, finalLastName].filter(Boolean).join(" ") || invitation.email;

    let user;
    let account;
    let accountUser;

    if (invitation.type === "client") {
      // Check email not already registered
      const existingUser = await User.findOne({ email: invitation.email }).lean();
      if (existingUser) {
        return res.status(409).json({ error: "A user with this email already exists" });
      }

      const hashedPassword = await bcrypt.hash(password, 10);

      account = await Account.create({
        name: displayName,
        ghl: invitation.ghl || null,
      });

      user = await User.create({
        account_id: account._id,
        email: invitation.email,
        password: hashedPassword,
        first_name: finalFirstName,
        last_name: finalLastName,
        role: 1,
      });

      accountUser = await AccountUser.create({
        user_id: user._id,
        account_id: account._id,
        role: 1,
        has_outbound: false,
        has_research: true,
        is_default: true,
      });
    } else if (invitation.type === "team_member") {
      // Check if user with email already exists
      user = await User.findOne({ email: invitation.email });

      if (user) {
        // Check not already a member of this account
        const existingMembership = await AccountUser.findOne({
          user_id: user._id,
          account_id: invitation.account_id,
        }).lean();
        if (existingMembership) {
          return res.status(409).json({ error: "User is already a member of this account" });
        }
      } else {
        // Create new user
        const hashedPassword = await bcrypt.hash(password, 10);
        user = await User.create({
          account_id: invitation.account_id,
          email: invitation.email,
          password: hashedPassword,
          first_name: finalFirstName,
          last_name: finalLastName,
          role: invitation.role,
        });
      }

      account = await Account.findById(invitation.account_id);
      if (!account) {
        return res.status(404).json({ error: "Account not found" });
      }

      accountUser = await AccountUser.create({
        user_id: user._id,
        account_id: invitation.account_id,
        role: invitation.role,
        has_outbound: invitation.has_outbound,
        has_research: invitation.has_research,
        is_default: false,
      });
    }

    // Mark invitation as accepted
    invitation.status = "accepted";
    await invitation.save();

    // Generate JWT
    const jwtToken = generateToken(user, account, accountUser);

    logger.info({ invitationId: invitation._id, userId: user._id, type: invitation.type }, "Invitation accepted");
    res.json({
      token: jwtToken,
      user: {
        _id: user._id,
        email: user.email,
        first_name: user.first_name,
        last_name: user.last_name,
        role: user.role,
      },
      account: {
        _id: account._id,
        name: account.name,
        ghl: account.ghl,
      },
    });
  } catch (err) {
    logger.error({ err }, "Failed to accept invitation");
    res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;
