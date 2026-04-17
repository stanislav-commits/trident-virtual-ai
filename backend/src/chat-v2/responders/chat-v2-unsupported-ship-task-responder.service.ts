import { Injectable } from '@nestjs/common';
import { ChatV2Language } from '../chat-v2.types';

@Injectable()
export class ChatV2UnsupportedShipTaskResponderService {
  respond(language: ChatV2Language): { content: string } {
    switch (language) {
      case 'uk':
        return {
          content:
            'Я зрозумів, що це ship-related запит, але в chat-v2 ми поки ще не підключили маршрутизацію в мануали, метрики чи історичні дані.',
        };
      case 'ru':
        return {
          content:
            'Я понял, что это ship-related запрос, но в chat-v2 мы пока ещё не подключили маршрутизацию в мануалы, метрики или исторические данные.',
        };
      case 'it':
        return {
          content:
            'Ho capito che questa richiesta riguarda la nave, ma in chat-v2 non abbiamo ancora collegato il routing verso manuali, metriche o dati storici.',
        };
      case 'en':
      case 'unknown':
      default:
        return {
          content:
            'I understood this as a ship-related task, but chat-v2 does not have manuals, metrics, or historical vessel routing connected yet.',
        };
    }
  }
}
