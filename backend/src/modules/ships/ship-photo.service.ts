import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ShipEntity } from './entities/ship.entity';
import { ShipPhotoStorageService } from './ship-photo-storage.service';

/**
 * Accepted types are the ones a browser will actually render in an <img>. HEIC is
 * deliberately absent: an iPhone photo dropped in here would upload fine and then
 * show as a broken image, which is worse than a refusal that says why.
 */
const ACCEPTED = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MAX_BYTES = 8 * 1024 * 1024;

export interface ShipPhotoFile {
  buffer: Buffer;
  mimetype: string;
  size: number;
  originalname?: string;
}

@Injectable()
export class ShipPhotoService {
  constructor(
    @InjectRepository(ShipEntity)
    private readonly ships: Repository<ShipEntity>,
    private readonly storage: ShipPhotoStorageService,
  ) {}

  async upload(shipId: string, file: ShipPhotoFile | undefined): Promise<void> {
    if (!file?.buffer?.length) {
      throw new BadRequestException('No file was uploaded.');
    }
    if (file.size > MAX_BYTES) {
      throw new BadRequestException('The photo must be 8 MB or smaller.');
    }
    const mime = (file.mimetype || '').toLowerCase();
    if (!ACCEPTED.has(mime)) {
      throw new BadRequestException(
        `Unsupported image type ${mime || 'unknown'}. Use JPEG, PNG or WebP — a HEIC photo from an iPhone has to be converted first.`,
      );
    }
    const ship = await this.ships.findOne({ where: { id: shipId } });
    if (!ship) throw new NotFoundException(`Ship ${shipId} not found`);

    const provider = await this.storage.save(shipId, file.buffer, mime);
    await this.ships.update(shipId, {
      photoProvider: provider,
      photoMime: mime,
      photoUpdatedAt: new Date(),
    });
  }

  async read(shipId: string): Promise<{ buffer: Buffer; mime: string }> {
    const ship = await this.ships.findOne({ where: { id: shipId } });
    if (!ship) throw new NotFoundException(`Ship ${shipId} not found`);
    if (!ship.photoProvider) {
      throw new NotFoundException('This vessel has no photo.');
    }
    const provider = ship.photoProvider === 'spaces' ? 'spaces' : 'local';
    try {
      const buffer = await this.storage.read(provider, shipId);
      return { buffer, mime: ship.photoMime ?? 'image/jpeg' };
    } catch {
      // The row says there is a photo and the binary is gone. Reported as a
      // missing photo rather than a 500: the caller's next move is a re-upload.
      throw new NotFoundException('The photo file is missing from storage.');
    }
  }

  async remove(shipId: string): Promise<void> {
    const ship = await this.ships.findOne({ where: { id: shipId } });
    if (!ship) throw new NotFoundException(`Ship ${shipId} not found`);
    if (!ship.photoProvider) return;
    const provider = ship.photoProvider === 'spaces' ? 'spaces' : 'local';
    // Row first: a cleared row with an orphaned object is recoverable, a row
    // pointing at a deleted object is a broken image on the page.
    await this.ships.update(shipId, {
      photoProvider: null,
      photoMime: null,
      photoUpdatedAt: null,
    });
    await this.storage.delete(provider, shipId);
  }
}
