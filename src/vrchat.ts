import axios from "axios";
import { wrapper } from "axios-cookiejar-support";
import { Capabilities } from "capabilities";
import config from "config";
import { EmbedBuilder } from "discord.js";
import { Secret, TOTP } from "otpauth";
import { CookieJar } from "tough-cookie";
import VRCGroup from "types/vrcgroup";
import VRCLog, { LogEventColors, LogEventReadable } from "types/vrclog";
import { sendMessage } from "./discord/rest";

const totp = new TOTP({
  algorithm: "SHA1",
  digits: 6,
  period: 30,
  secret: Secret.fromBase32(
    config.config.credentials.vrchat.totp.replace(/ /g, "")
  ),
});

const jar = new CookieJar();

export const vrcClient = wrapper(
  axios.create({
    jar,
    baseURL: "https://vrchat.com/api/1",
    headers: {
      "User-Agent": "VRCDiscordBot/1.0.0 (https://github.com/imlvna)",
    },
  })
);
let validGroups: VRCGroup[] = [];
export function setValidGroups(groups: VRCGroup[]) {
  validGroups = groups;
}
export function getValidGroups() {
  return validGroups;
}
let initalized = false;
export async function init() {
  if (initalized) return;
  await vrcClient
    .get("/auth/user", {
      headers: {
        Authorization: `Basic ${btoa(`${encodeURIComponent(config.config.credentials.vrchat.username)}:${encodeURIComponent(config.config.credentials.vrchat.password)}`)}`,
      },
    })
    .catch(() => {});
  await vrcClient
    .post("/auth/twofactorauth/totp/verify", {
      code: totp.generate(),
    })
    .catch(() => {});
  initalized = true;
  console.log("VRChat API initialized");
}

let lastFetched = new Date().toISOString();
export async function getNewLogs(): Promise<Map<string, VRCLog[]>> {
  return (
    await Promise.all(
      validGroups
        .filter((i) => {
          config.config.vrchat.groupIds[i.id].capabilities[
            Capabilities.Logs
          ] !== undefined;
        })
        .map(async (group) => {
          const newLogs: {
            results: VRCLog[];
          } = await vrcClient
            .get(`/groups/${group.id}/auditLogs?startDate=${lastFetched}`)
            .then((res) => res.data)
            .catch((e) => {
              console.error(e);
              console.error(e.response.data);
            });
          lastFetched = new Date().toISOString();
          return [
            group.id,
            newLogs.results.sort((i, a) => {
              return (
                new Date(i.created_at).getTime() -
                new Date(a.created_at).getTime()
              );
            }),
          ];
        })
    )
  ).reduce((acc, i) => {
    acc.set(i[0] as string, i[1] as VRCLog[]);
    return acc;
  }, new Map<string, VRCLog[]>());
}

export async function sendNewLogs(groups: Map<string, VRCLog[]>) {
  const embeds: EmbedBuilder[] = [];
  for (const group of groups.keys()) {
    for (const log of groups.get(group)!) {
      const embed = new EmbedBuilder()
        .setTitle(LogEventReadable[log.eventType] || log.eventType)
        .setColor(LogEventColors[log.eventType] || 0x000000)
        .setAuthor({
          name: validGroups.find((i) => i.id === group)?.name || "Unknown",
        })
        .setDescription(log.description);
      if (log.targetId) {
        embed.setFooter({
          text: `Target: ${log.targetId}`,
        });
      }
      embeds.push(embed);
    }
  }
  if (embeds.length === 0) return;
  // chunk the embeds into 10
  for (let i = 0; i < embeds.length; i += 10) {
    await sendMessage(config.config.discord.channelIds.logs, {
      embeds: embeds.slice(i, i + 10),
    });
  }
}
