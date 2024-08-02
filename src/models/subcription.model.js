import mongoose, { Schema } from "mongoose";

const subscriptionSchema =  new Schema({
    subscriber: {
        type: Schema.Types.ObjectId, // one who is sbscribing
        ref: "User"
    },
    channel: {
        type: Schema.Types.ObjectId, // one to whom user subscribing
        ref: "User"
    },
},{ timestamps: true})

export const Subscription = mongoose.model("Subscription", subscriptionSchema)