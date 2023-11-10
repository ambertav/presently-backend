import User from "../user/models/user";
import Expo, { ExpoPushMessage, ExpoPushTicket } from "expo-server-sdk";
import { ticketCache } from "../../utilities/cache";

export interface IApproachingBirthday {
    userId: string;
    email: string;
    token: string | null;
    friendId: string;
    friendName: string;
    hoursUntil: number;
    emailNotifications: boolean;
    pushNotifications: boolean;
}

export async function getApproachingBirthdays(cutoffHours: number = 96, lastNotificationClearance: number = 24): Promise<IApproachingBirthday[]> {
    try {
        // find users, who have either emailNotification or pushNotification set to true in their UserProfile
        // whose friends have an upcoming birthday with less than cutoffHours, calculated according to the timezone settings in UserProfile (for each user)
        // AND who haven't been sent a Notification in more than lastNotificationClearance
        const currentDateTime = new Date();
        const notificationClearanceDateTime = new Date(currentDateTime.getTime() - lastNotificationClearance * 3600000);
        const users = await User.aggregate([
            {
                // Lookup UserProfile to filter users based on notification settings
                $lookup: {
                    from: 'userprofiles',
                    localField: '_id',
                    foreignField: 'user',
                    as: 'userProfile'
                }
            },
            { $unwind: '$userProfile' },
            {
                // Match users with notifications enabled
                $match: {
                    $or: [
                        { 'userProfile.emailNotifications': true },
                        { 'userProfile.pushNotifications': true }
                    ]
                }
            },
            // Lookup friends for each user
            {
                $lookup: {
                    from: 'friends',
                    localField: '_id',
                    foreignField: 'user',
                    as: 'friends'
                }
            },
            { $unwind: '$friends' },
            // Calculate the hours until each friend's upcoming birthday
            // Convert the friends' dob to their upcoming birthday date
            {
                $addFields: {
                    'thisYearBirthday': {
                        $dateFromParts: {
                            'year': { $year: currentDateTime },
                            'month': { $month: '$friends.dob' },
                            'day': { $dayOfMonth: '$friends.dob' },
                            'timezone': '$userProfile.timezone'
                        }
                    }
                }
            },
            {
                $addFields: {
                    'nextYearBirthday': {
                        $dateFromParts: {
                            'year': { $add: [{ $year: currentDateTime }, 1] },
                            'month': { $month: '$friends.dob' },
                            'day': { $dayOfMonth: '$friends.dob' },
                            'timezone': '$userProfile.timezone'
                        }
                    }
                }
            },
            {
                $addFields: {
                    'upcomingBirthday': {
                        $cond: {
                            if: { $lt: ['$thisYearBirthday', currentDateTime] }, // if the birthday this year has passed
                            then: '$nextYearBirthday', // use the birthday next year
                            else: '$thisYearBirthday' // otherwise, use the birthday this year
                        }
                    }
                }
            },
            {
                // Calculate hours until upcoming birthday
                $addFields: {
                    'hoursUntilBirthday': {
                        $dateDiff: {
                            startDate: currentDateTime,
                            endDate: '$upcomingBirthday',
                            unit: 'hour',
                            timezone: '$userProfile.timezone'
                        }
                    }
                }
            },
            {
                // Filter those not within cutoffHours
                $match: {
                    'hoursUntilBirthday': { $lte: cutoffHours }
                }
            },
            // Lookup notifications to exclude friends with recent notifications
            {
                $lookup: {
                    from: 'notifications',
                    let: { userId: '$userProfile.user', friendId: '$friends._id' },
                    pipeline: [
                        {
                            $match: {
                                $expr: {
                                    $and: [
                                        { $eq: ['$userId', '$$userId'] },
                                        { $eq: ['$friendId', '$$friendId'] },
                                        { $gt: ['$dateSent', notificationClearanceDateTime] }
                                    ]
                                }
                            }
                        }
                    ],
                    as: 'recentNotifications'
                }
            },
            // Exclude friends with recent notifications
            { $match: { 'recentNotifications': { $size: 0 } } },
            // Lookup deviceIds for each user
            {
                $lookup: {
                    from: 'deviceinfos',
                    localField: '_id',
                    foreignField: 'userId',
                    as: 'device'
                }
            },
            {
                $unwind: { path: '$device', preserveNullAndEmptyArrays: true }
            },
            // Project the final structure
            {
                $project: {
                    userId: '$userProfile.user',
                    email: '$email',
                    token: '$device.deviceToken',
                    friendId: '$friends._id',
                    friendName: '$friends.name',
                    hoursUntil: '$hoursUntilBirthday',
                    emailNotifications: '$userProfile.emailNotifications',
                    pushNotifications: '$userProfile.pushNotifications'
                }
            }
        ]).exec();
        return users.map(user => ({
            userId: user.userId.toString(),
            email: user.email,
            token: user.token,
            friendId: user.friendId.toString(),
            friendName: user.friendName,
            hoursUntil: user.hoursUntil,
            emailNotifications: user.emailNotifications,
            pushNotifications: user.pushNotifications,
        }));
    } catch (error) {
        console.error(error);
        return [];
    }
}

export async function sendExpoNotifications(list: IApproachingBirthday[]) {
    const expo = new Expo();
    // filter only push notification allowed users
    const pushList = list.filter(item => !!item.pushNotifications && !!item.token);
    // TODO: Choose message body randomly from pool
    const messages = [];
    for (let item of pushList) {
        messages.push({
            to: item.token,
            sound: 'default',
            body: `${item.friendName}'s birthday is ${item.hoursUntil} hours away!`
        });
    }
    let chunks = expo.chunkPushNotifications(messages as ExpoPushMessage[]);
    let tickets: ExpoPushTicket[] = [];
    (async () => {
        for (let chunk of chunks) {
            try {
                let ticketChunk = await expo.sendPushNotificationsAsync(chunk);
                console.log(ticketChunk);
                tickets.push(...ticketChunk);
                // NOTE: If a ticket contains an error code in ticket.details.error, you
                // must handle it appropriately. The error codes are listed in the Expo
                // documentation:
                // https://docs.expo.io/push-notifications/sending-notifications/#individual-errors
            } catch (error) {
                console.error(error);
            }
        }
    })();
    // set ticket cache
    const identifier = Date.now().toString();
    ticketCache.set(identifier, JSON.stringify(tickets));
    setTimeout(async () => {
        await handleExpoReceipts(identifier);
    }, 60 * 1000);
}

export async function handleExpoReceipts(identifier: string) {
    try {
        const expo = new Expo();
        const tickets = JSON.parse(ticketCache.get(identifier)!)
        let receiptIds = [];
        for (let ticket of tickets) {
            // NOTE: Not all tickets have IDs; for example, tickets for notifications
            // that could not be enqueued will have error information and no receipt ID.
            if (ticket.id) {
                receiptIds.push(ticket.id);
            }
        }

        let receiptIdChunks = expo.chunkPushNotificationReceiptIds(receiptIds);
        // Like sending notifications, there are different strategies you could use
        // to retrieve batches of receipts from the Expo service.
        for (let chunk of receiptIdChunks) {
            try {
                let receipts = await expo.getPushNotificationReceiptsAsync(chunk);
                console.log(receipts);

                // The receipts specify whether Apple or Google successfully received the
                // notification and information about an error, if one occurred.
                for (let receiptId in receipts) {
                    // @ts-expect-error
                    let { status, message, details } = receipts[receiptId];
                    if (status === 'ok') {
                        continue;
                    } else if (status === 'error') {
                        console.error(
                            `There was an error sending a notification: ${message}`
                        );
                        // @ts-expect-error
                        if (details && details.error) {
                            // The error codes are listed in the Expo documentation:
                            // https://docs.expo.io/push-notifications/sending-notifications/#individual-errors
                            // You must handle the errors appropriately.
                            // @ts-expect-error
                            console.error(`The error code is ${details.error}`);
                        }
                    }
                }
            } catch (error) {
                console.error(error);
            }
        }
    } catch (error) {
        console.error(error);
    }

}