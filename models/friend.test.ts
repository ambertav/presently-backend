import mongoose from "mongoose";
import Friend from "./friend";
import Gift from "./gift";

const now = new Date();

declare global {
    var __MONGO_URI__: string;
}

beforeAll(async () => {
    await mongoose.connect(global.__MONGO_URI__);
    await Friend.deleteMany({});
});

afterAll(async () => {
    await mongoose.connection.close();
});

describe('Friend DOB Validation', () => {
    it('should allow DOB in the past', async () => {
        const validDOB = new Date(now);
        validDOB.setFullYear(now.getFullYear() - 100);

        const validFriend = await Friend.create({
            firstName: 'test',
            lastName: 'test',
            dob: validDOB,
            photo: 'test'
        });

        expect(validFriend).toBeDefined();
    });

    it('should reject a future date for DOB', async () => {
        const futureDOB = new Date(now);
        futureDOB.setFullYear(now.getFullYear() + 1);

       try {
            await Friend.create({
                firstName: 'test',
                lastName: 'test',
                dob: futureDOB,
                photo: 'test',
            });

            fail('Expected an error, but the friend was created'); // fails test if friend was created with invalid DOB
        } catch (error : any) {
            expect(error.message).toContain('Date of birth cannot be in the future'); // passes test if friend is not created
        }
    });


    it('should allow a DOB that is equal to the current date', async () => {
        const newborn = await Friend.create({
            firstName: 'test',
            lastName: 'test',
            dob: now,
            photo: 'test',
        });

        expect(newborn).toBeDefined();
    });
});
