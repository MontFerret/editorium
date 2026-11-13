import * as assert from 'node:assert/strict';
import { FerretServerController } from '../controller';

suite('Ferret coordinated server lifecycle', () => {
  test('starts and restarts LSP independently and dispatches binary changes to both owners', async () => {
    const events: string[] = [];
    const event = async (name: string) => { events.push(name); };
    const controller = new FerretServerController({
      start: () => event('start LSP'), restart: () => event('restart LSP'), stop: () => event('stop LSP'),
    }, {
      restartExecutable: () => event('override'), shutdown: () => event('stop daemon'),
    });
    await controller.start();
    await controller.restartLanguageServer();
    assert.deepEqual(events, ['start LSP', 'restart LSP']);
    await controller.restart();
    await controller.stop();
    assert.deepEqual(events.slice(2), ['restart LSP', 'override', 'stop daemon', 'stop LSP']);
  });
});
