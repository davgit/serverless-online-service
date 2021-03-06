import { promisify } from 'util';

import * as azure from 'azure-sb';

import { debug as d } from '../debug';
import * as logger from '../logging';
import { delay } from '../misc';
import { ServiceBusListenerOptions, ServiceBusMessage } from '../types'; // eslint-disable-line no-unused-vars

const moduleName: string = 'Queue';
const debug: debug.IDebugger = d(__filename);

type Message = azure.Azure.ServiceBus.Message & {
    data: any;
}

type ServiceBus = azure.ServiceBusService & {
    deleteMessageAsync: (message: azure.Azure.ServiceBus.MessageOrName) => Promise<azure.Azure.ServiceBus.Response>;
    getQueueAsync: (queue: string) => Promise<azure.Azure.ServiceBus.Results.Models.Queue>;
    sendQueueMessageAsync: (queue: string, message: azure.Azure.ServiceBus.MessageOrName) => Promise<azure.Azure.ServiceBus.Response>;
    receiveQueueMessageAsync: (queue: string, options: azure.Azure.ServiceBus.ReceiveQueueMessageOptions) => Promise<Message>;
    unlockMessageAsync: (message: azure.Azure.ServiceBus.MessageOrName) => Promise<azure.Azure.ServiceBus.Response>;
}

export class Queue {
    /** Azure service bus. */
    private serviceBus: ServiceBus;
    /** Queue name. */
    private name: string;
    /** If the listener has to stop. */
    private stop?: boolean;
    /** Handler for a listener. */
    private handler: Function | null = null;
    /** Pooling time for the listener. */
    private pooling: number = 1000;
    /** Number of messages to get by the listener. */
    private messagesToGet: number = 1;
    /** Auto delete messages in queue after listener process it. */
    private autoDeleteMessages: boolean = true;

    /**
     * @constructor
     * @param {string} name - Queue name.
     * @param {string} connectionString - Connection string to ServiceBus.
     */
    public constructor(name: string, connectionString: string) {
        this.name = name;
        this.serviceBus = azure.createServiceBusService(connectionString) as ServiceBus;

        this.serviceBus.sendQueueMessageAsync = promisify(this.serviceBus.sendQueueMessage);
        this.serviceBus.receiveQueueMessageAsync = promisify(this.serviceBus.receiveQueueMessage) as any;
        this.serviceBus.getQueueAsync = promisify(this.serviceBus.getQueue);
        this.serviceBus.deleteMessageAsync = promisify(this.serviceBus.deleteMessage);
        this.serviceBus.unlockMessageAsync = promisify(this.serviceBus.unlockMessage);
    }

    private retry<T>(action: () => Promise<T>, errMessage: string) {
        let retries = 10;

        const ret = async (): Promise<T> => {
            try {
                return await action();
            } catch (err) {
                logger.error(`Error ${errMessage} ${this.name}`, moduleName, err);
                retries--;

                if (retries === 0) {
                    throw err;
                }

                await delay((err.statusCode === 503 ? 10 : 1) * 1000);

                return ret();
            }
        };

        return ret();
    }

    /**
     * Send a message to service bus.
     * @param {any} message - Message to send to the queue.
     */
    public sendMessage(message: any) {
        debug('Sending message to queue');

        return this.retry<azure.Azure.ServiceBus.Response>(() => {
            return this.serviceBus.sendQueueMessageAsync(this.name, { body: JSON.stringify(message) });
        }, 'sending message to');
    }

    /**
     * Get a message from service bus.
     */
    public async getMessage(remove?: boolean) {
        try {
            debug(`Getting message in queue ${this.name}`);

            const message = await this.serviceBus.receiveQueueMessageAsync(this.name, { isPeekLock: !remove });

            if (message.body) {
                message.data = JSON.parse(message.body);
            }

            return message;
        } catch (err) {
            // azure-sb package returns an error if there is no messages in the queue.
            if (err === 'No messages to receive') {
                return null;
            }

            debug('Error getting message', err);
            throw err;
        }
    }

    public async deleteMessage(message: Message) {
        try {
            await this.serviceBus.deleteMessageAsync(message);
        } catch (err) {
            logger.error('Error deleting message', moduleName, err);
        }
    }

    public async unlockMessage(message: Message) {
        try {
            await this.serviceBus.unlockMessageAsync(message);
        } catch (err) {
            logger.error('Error unlocking message', moduleName, err);
        }
    }

    public getMessagesCount(): Promise<number> {
        return this.retry(async () => {
            const queue = await this.serviceBus.getQueueAsync(this.name);

            return parseInt(queue.MessageCount);
        }, 'getting messages count in');
    }

    private async getMessages(): Promise<any[]> {
        let count = this.messagesToGet;
        const messages = [];

        while (count > 0) {
            const message = await this.getMessage();

            if (message) {
                messages.push(message);
                count--;
            } else {
                count = 0;
            }
        }

        return messages;
    }

    private async checkQueue() {
        let messages;
        const startTime = Date.now();

        try {


            messages = await this.getMessages();
        } catch (err) {
            messages = null;

            if (err.code !== 'ETIMEDOUT') {
                logger.error('Error getting message', moduleName, err);
            }

            if (err.statusCode === 503) {
                return 10000; // Throttling error. We need to wait 10 seconds for the next request.
            }
        }

        if (!messages || messages.length === 0) {
            return null;
        }

        logger.log(`Time to get ${messages.length} messages from queue: ${(Date.now() - startTime) / 1000} seconds`, moduleName);

        try {
            await this.handler!(messages);

            // Remove the message from the queue when the handler finishes.
            if (this.autoDeleteMessages) {
                for (const message of messages) {
                    await this.deleteMessage(message);
                }
            }

            return 0;
        } catch (err) {
            logger.error(`Error processing message: \n${JSON.stringify(messages)}`, moduleName, err);

            return null;
        }
    }

    public async listen(handler: (messages: ServiceBusMessage[]) => any, options?: ServiceBusListenerOptions): Promise<void> {
        if (!handler) {
            throw new Error('Listen needs a handler to work');
        }

        if (this.handler) {
            throw new Error('There is already a listener defined. Stop the previous one');
        }

        if (options) {
            this.pooling = options.pooling || this.pooling;
            this.messagesToGet = options.messagesToGet || this.messagesToGet;
            this.autoDeleteMessages = typeof options.autoDeleteMessages !== 'undefined' ? options.autoDeleteMessages : true;
        }

        this.stop = false;
        this.handler = handler;

        while (!this.stop) {
            const waitingTime = await this.checkQueue();

            await delay(typeof waitingTime === 'number' ? waitingTime : this.pooling);
        }
    }

    public stopListener() {
        this.stop = true;
        this.handler = null;
    }
}
