# DoorsFPS Community Server Terms of Use

**Version:** 2026-10-26

**Last updated:** October 26, 2026

These Terms of Use ("Terms") are an agreement between you and DoorsFPS ("Doors," "we," "us," or "our"), the operator of the game at doorsfps.com. They cover the DoorsFPS community server software (this package, the `doors-server` binaries built from it, and anything you build from it), plus the official DoorsFPS services you reach while you use it.

The server asks you to accept these Terms every time it starts. If you do not agree, do not run the server.

## 1. Definitions

- **Community server software** means the source code in this package and any build of it, modified or not.
- **Community server** means a copy of that software that someone other than DoorsFPS runs on hardware they control.
- **Operator** means the person or group that runs a community server. If you start the server, you are the operator.
- **Official services** means everything DoorsFPS runs itself: the official game servers and matchmaking, the authority and account APIs, ranked play, the in-game economy and stores, the website, the downloads, and the infrastructure behind them.

## 2. These Terms and the software license

The community server source code is released under the MIT License. These Terms do not take away any right that license gives you. You may use, copy, modify, merge, publish, distribute, sublicense, and sell copies of the software as the license allows.

These Terms do something different. They set the conditions for using **official services** in connection with the software, and they set the conduct expected of operators. The license says what you can do with the code. These Terms say what DoorsFPS will tolerate on, and from, the network it runs. If the two seem to conflict, the license controls what you may do with the code, and these Terms control your access to official services.

These Terms add to the DoorsFPS Terms of Service at https://doorsfps.com/terms-of-service. If you play on official services, both apply. Where they overlap on a community server topic, these Terms are the more specific ones.

## 3. Accepting these Terms at startup

Each time it boots, the server shows a notice and waits for you to accept these Terms. On a machine with no terminal (a service, a container, a pipe), you accept by passing `--accept-terms` or setting `DOORS_ACCEPT_TERMS=1`. Passing that flag or setting that variable is the same as typing your acceptance.

The license allows you to change the code, including the acceptance check. Removing or bypassing the check does not release you from these Terms. Neither does running a build where someone else removed it. If you remove the check, or ship builds without it, to help yourself or others avoid these Terms, we treat that as evidence of bad faith when we decide on enforcement under Section 8.

## 4. What community servers may do

On hardware you own or have permission to use, you may:

- Change gameplay, rules, balance, game modes, maps, bots, and server behavior.
- Run custom clients, bots, tools, and mods for development, testing, administration, accessibility, and play.
- Stress test, profile, fuzz, and look for security bugs in **your own** community server.
- Host matches for friends or for a community you run, for free or for money, as the license allows.

Community servers do not have to match official gameplay. Experimenting on your own infrastructure is fine, and nothing in these Terms limits it.

## 5. What you may not do to official services

Whether you use the community server software, the official client, a modified client, a bot, or any other tool, you may not:

1. **Attack official services.** This means denial-of-service attacks, flooding, load testing, scanning, or probing we did not authorize, plus any attempt to disrupt, overload, or degrade official servers or infrastructure.
2. **Break in.** Do not access official systems, accounts, or data you are not authorized to reach. Do not forge, replay, steal, or share join tokens, admin tokens, match reports, or other credentials. Do not get around rate limits, admission checks, anti-cheat, or other security controls.
3. **Pretend to be official.** Do not set up a community server to pose as an official server, an official runtime, or the authority. That covers spoofing official server or runtime ids, reporting matches or heatmaps to official APIs, and trying to put XP, Skill, rank, coins, cosmetics, or other progress onto official accounts from a community server.
4. **Cheat on official servers.** This covers aimbots, wallhacks, input automation, modified clients, unauthorized bots, packet tampering, and exploiting bugs for an advantage on official servers, in ranked play, or in the economy.
5. **Abuse other players.** Do not use the game, its services, or a community server to harass, threaten, dox, defraud, or sabotage people, or to collect their information without permission.
6. **Mislead people about who runs your server.** You may say your server runs DoorsFPS software. Do not use the DoorsFPS name, logo, or official assets in a way that suggests we run, endorse, or moderate your server.
7. **Break the law.** Do not use the software or services for anything illegal, or to spread malware, illegal content, or content that infringes someone else's rights.

## 6. Operator responsibilities

As an operator, you are responsible for:

- Your machine, network, configuration, join password, and who you give the address to.
- The maps, bots, mods, and other files you load or share, and making sure you have the right to use them.
- Any data your server logs or collects about players. You must follow the privacy and child-protection laws that apply to you and your players. DoorsFPS does not receive or control that data.
- The rules on your server and how you enforce them.

We do not review, moderate, or support community servers. We are not responsible for what happens on them.

## 7. Security research and reporting

Test your own community server as much as you like. Do not test official services unless we have given you written permission first. If you find a vulnerability that affects official services, email contact@doorsfps.com with enough detail for us to reproduce it, and do not exploit it or disclose it publicly until we have had a reasonable chance to fix it. We will not take action under these Terms against good-faith research that follows this section.

Nothing in these Terms authorizes access to any system you do not own or have permission to test.

## 8. Enforcement

If we reasonably believe you broke these Terms, we may do any of the following without notice, as far as the law allows:

- Warn you, reset ranks, or remove coins, items, or progress.
- Suspend or **permanently ban** your DoorsFPS accounts and any accounts we reasonably link to you.
- **Block IP addresses, network ranges, devices, or community server deployments** from reaching official services.
- Revoke or rotate credentials, tokens, or keys tied to your activity.
- Keep logs and evidence, and report the conduct to hosting providers, payment processors, or law enforcement.
- Pursue any other remedy the law allows, including damages for harm to official services.

We decide what to enforce and how. Not acting in one case does not waive our right to act in another. Enforcement under these Terms only limits your access to **official services**. It does not revoke your rights under the software license.

## 9. No warranty and limits on liability

The community server software is provided "as is," as stated in the MIT License. These Terms add no warranty and do not change that disclaimer. As far as the law allows, DoorsFPS is not liable for damage to your systems, lost data, lost profits, or harm caused by a community server, its operator, or its players. You agree to indemnify DoorsFPS against claims arising from a community server you operate or from your breach of these Terms. The disclaimers, liability limits, dispute resolution, and governing law sections of the DoorsFPS Terms of Service also apply to these Terms.

## 10. Changes

We may update these Terms. Each version has a version string and a "Last updated" date at the top of this file, and the server shows the version it is asking you to accept. A new version applies to you once a server build that includes it asks you to accept it, or once we publish it in the community server source, whichever comes first. If you do not agree to a new version, stop using official services, and stop running builds that include that version.

## 11. Contact

Send questions about these Terms, and security reports, to contact@doorsfps.com.
