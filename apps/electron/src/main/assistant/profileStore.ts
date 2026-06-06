import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { SpeakerProfileSummary } from "./types";

interface SpeakerMetadataFile {
  speakers: SpeakerProfileSummary[];
}

export class FileSpeakerProfileStore {
  readonly directory: string;
  readonly metadataPath: string;

  private readonly profilesDirectory: string;

  constructor(userDataDirectory: string) {
    this.directory = userDataDirectory;
    this.profilesDirectory = join(userDataDirectory, "speaker-profiles");
    this.metadataPath = join(this.profilesDirectory, "speakers.json");
  }

  async list(): Promise<SpeakerProfileSummary[]> {
    const metadata = await this.readMetadata();
    return metadata.speakers;
  }

  async create(name: string): Promise<SpeakerProfileSummary> {
    const trimmedName = name.trim();

    if (trimmedName.length === 0) {
      throw new Error("Speaker name is required.");
    }

    await this.ensureDirectory();

    const metadata = await this.readMetadata();
    const speaker: SpeakerProfileSummary = {
      allowed: true,
      createdAt: new Date().toISOString(),
      id: `speaker-${randomUUID()}`,
      name: trimmedName,
    };

    await this.writeMetadata({
      speakers: [...metadata.speakers, speaker],
    });

    return speaker;
  }

  async setAllowed(
    speakerId: string,
    allowed: boolean,
  ): Promise<SpeakerProfileSummary | null> {
    const metadata = await this.readMetadata();
    const speaker = metadata.speakers.find((candidate) => candidate.id === speakerId);

    if (!speaker) {
      return null;
    }

    const updatedSpeaker = { ...speaker, allowed };
    await this.writeMetadata({
      speakers: metadata.speakers.map((candidate) =>
        candidate.id === speakerId ? updatedSpeaker : candidate,
      ),
    });

    return updatedSpeaker;
  }

  async delete(speakerId: string): Promise<boolean> {
    const metadata = await this.readMetadata();
    const speakerExists = metadata.speakers.some(
      (candidate) => candidate.id === speakerId,
    );

    if (!speakerExists) {
      return false;
    }

    await this.writeMetadata({
      speakers: metadata.speakers.filter((candidate) => candidate.id !== speakerId),
    });

    return true;
  }

  private async ensureDirectory(): Promise<void> {
    await mkdir(this.profilesDirectory, { recursive: true });
  }

  private async readMetadata(): Promise<SpeakerMetadataFile> {
    try {
      const rawMetadata = await readFile(this.metadataPath, "utf8");
      const parsedMetadata = JSON.parse(rawMetadata) as SpeakerMetadataFile;
      return {
        speakers: Array.isArray(parsedMetadata.speakers)
          ? parsedMetadata.speakers
          : [],
      };
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return { speakers: [] };
      }

      throw error;
    }
  }

  private async writeMetadata(metadata: SpeakerMetadataFile): Promise<void> {
    await this.ensureDirectory();
    await writeFile(this.metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
  }
}
