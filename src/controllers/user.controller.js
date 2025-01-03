import { asyncHandler } from "../utils/asyncHandler.js"; // it is used to handle the async request
import { ApiError } from "../utils/ApiError.js";
import { User } from "../models/user.model.js";
import { uploadOnCloudinary, deleteFromCloudinary } from "../utils/cloudinary.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import jwt from "jsonwebtoken"
import mongoose from "mongoose";

const generateAccessAndRefreshTokens = async (userId) => {
    try {
        const user = await User.findById(userId)
        const accessToken = user.generateAccessToken()
        const refreshToken = user.generateRefreshToken()
        user.refreshToken = refreshToken
        await user.save({ validateBeforeSave: false }) // we are not validating the user before saving because we are not updating the user, we are just updating the refreshToken
        return { accessToken, refreshToken }
    } catch (error) {
        throw new ApiError(500, "Something went wrong while generating refresh and access token")
    }
}

// it is an async function which takes request and response as an argument and it is wrapped inside the asyncHandler function to handle the async request
const registerUser = asyncHandler(async (req, res) => {

    // get user details from frontend
    const {fullName, email, username, password} = req.body
    // console.log('********** req.body **********');
    // console.log(req.body);

    // validation - not empty
    if (
        [fullName, email, username, password].some((field) => field?.trim() === "")
    ) {
        throw new ApiError(400, "All fields are required")
    }

    // check if user already exists - username, email
    const existedUser = await User.findOne({
        $or: [{ username }, { email }]
    })
    if(existedUser) throw new ApiError(409, "User with email or username already exists")

    // check for images, check for avatar
    const avatarLocalPath = req.files?.avatar[0]?.path // by adding multer middleware, we can access the files from the request object and the path of the file is stored in the path property (we get the path from the first property of the avatar array)
    // console.log('********** req.files **********');
    // console.log(req.files);
    // const coverImageLocalPath = req.files?.coverImage[0]?.path
    let coverImageLocalPath;
    if(req.files && Array.isArray(req.files.coverImage) && req.files.coverImage.length > 0){
        coverImageLocalPath = req.files.coverImage[0].path
        // In the previous case there is an issue, if there is no coverimage then no need to access coverImage[0]
    }
    if(!avatarLocalPath) throw new ApiError(400, "Avatar File is required")

    // upload them to cloudinary, avatar
    const avatar = await uploadOnCloudinary(avatarLocalPath)
    const coverImage = await uploadOnCloudinary(coverImageLocalPath)
    if(!avatar) throw new ApiError(400, "Avatar File could not be uploaded")

    // create user object - create entry in db
    const user = await User.create({
        fullName,
        avatar: avatar.url,
        coverImage: coverImage?.url || "", // cover image is optional so check if it exists
        email,
        password,
        username: username.toLowerCase()
    })

    // remove password and refresh token field from response
    const createdUser = await User.findById(user._id).select(
        "-password -refreshToken"
    )

    // check if user is created
    if(!createdUser) throw new ApiError(500, "Something went wrong while registering the user")
    
    // return response
    return res.status(201).json(
        new ApiResponse(200, createdUser, "User Registered Successfully")
    )
})

const loginUser = asyncHandler (async (req, res) => {
    // req.body -> data
    const {email, username, password} = req.body

    // username or email
    if(!(username || email)){
        throw new ApiError(400, "username or email is required")
    }
    
    // find the user
    const user = await User.findOne({
        $or: [{ username }, { email }] // when we have multiple conditions then we use $or
    })
    if(!user) throw new ApiError(404, "User not found")

    // password check
    const isPasswordValid = await user.isPasswordCorrect(password) // isPasswordCorrect is a custom method which we have created in the user model so we can access it using the user object
    if(!isPasswordValid) throw new ApiError(401, "Invalid user credentials")

    // access and refresh token
    const {accessToken, refreshToken} = await generateAccessAndRefreshTokens(user._id)

    const loggedInUser = await User.findById(user._id).select("-password -refreshToken")
    
    // send cookie
    const options = {
        httpOnly: true, 
        secure: true 
        // now the cookies can only be modified from the server side not from the client side
    }

    return res.status(200)
    .cookie("accessToken", accessToken, options) // key, value, options
    .cookie("refreshToken", refreshToken, options)
    .json(
        new ApiResponse(
            200,
            {
                user: loggedInUser, accessToken, refreshToken
            },
            "User loggedIn Succesfully"
        )
    )
})

const logoutUser = asyncHandler(async (req, res) => {
    await User.findByIdAndUpdate(
        req.user._id,
        {
            $unset: {
                refreshToken: 1 // it will remove the refreshToken field from the user object
            }
        },
        {
            new: true // it will return the updated user object
        }
    )

    const options = {
        httpOnly: true, 
        secure: true
    }

    return res
    .status(200)
    .clearCookie("accessToken", options)
    .clearCookie("refreshToken", options)
    .json(new ApiResponse(200, {}, "User Logged Out"))
})

const refreshAccessToken = asyncHandler(async (req, res) => {
    const incomingRefreshToken = req.cookies.refreshToken || req.body.refreshToken

    if(!incomingRefreshToken) throw new ApiError(401, "Unauthorized request")
    
    try {
        const decodedToken = jwt.verify(
            incomingRefreshToken,
            process.env.REFRESH_TOKEN_SECRET
        )
    
        const user = await User.findById(decodedToken?._id)
        if(!user) throw new ApiError(401, "Invalid refresh token")
    
        if(incomingRefreshToken !== user?.refreshToken)
            throw new ApiError(401, "Refresh token is expired or used")
    
        const options = {
            httpOnly: true,
            secure: true
        }
        const {accessToken, newrefreshToken} = await generateAccessAndRefreshTokens(user._id)
    
        return res
        .status(200)
        .cookie("accessToken", accessToken, options)
        .cookie("refreshToken", newrefreshToken, options)
        .json(
            new ApiResponse(
                200,
                {accessToken, refreshToken: newrefreshToken},
                "Access token refreshed"
            )
        )
    } catch (error) {
        throw new ApiError(401, "Invalid refresh Token")
    }
})

const changeCurrentPassword = asyncHandler(async (req, res) => {
    const {oldPassword, newPassword} = req.body
    const user = await User.findById(req.user?._id)
    const isPasswordCorrect = await user.isPasswordCorrect(oldPassword)

    if(!isPasswordCorrect)
        throw new ApiError(400, "Invalid old Password")

    user.password = newPassword
    await user.save({validateBeforeSave: false})

    return res
    .status(200)
    .json(new ApiResponse(200, {}, "Password Changed Successfully"))
})

const getCurrentUser = asyncHandler(async (req, res) => {
    return res.status(200)
    .json(new ApiResponse(
        200, 
        req.user, 
        "Current user fetched Successfully"
    ))
})

const updateAccountDetails = asyncHandler(async (req, res) => {
    const {fullName, email} = req.body

    if(!(fullName || email)){
        throw new ApiError(400, "All fileds are required")
    }

    const user = await User.findByIdAndUpdate(
        req.user?._id,
        {
            $set: {
                fullName,
                email
            }
        },
        {new: true} // it will return the updated user object
    ).select("-password")

    return res
    .status(200)
    .json(new ApiResponse(200, user, "Account details updated successfully"))
})

const updateUserAvatar = asyncHandler(async (req, res) => {
    const avatarLocalPath = req.file?.path // we are getting the path of one file so we are using req.file not req.files

    if(!avatarLocalPath){
        throw new ApiError(400, "Avatar file is missing")
    }

    const imageToBeDeleted = req.user?.avatar
    if(imageToBeDeleted){
        const publicId = imageToBeDeleted.split("/").pop()?.split(".")[0]
        await deleteFromCloudinary(publicId)
    }

    const avatar = await uploadOnCloudinary(avatarLocalPath)

    if(!avatar.url){
        throw new ApiError(400, "Error while uploading on avatar")
    }

    const user = await User.findByIdAndUpdate(
        req.user?._id,
        {
            $set: {
                avatar: avatar.url
            }
        },
        {new: true}
    ).select("-password")

    return res
    .status(200)
    .json(new ApiResponse(200, user, "Avatar Image updated successfully"))
})

const updateUserCoverImage = asyncHandler(async (req, res) => {
    const coverImageLocalPath = req.file?.path

    if(!coverImageLocalPath){
        throw new ApiError(400, "Cover image file is missing")
    }

    const coverImage = await uploadOnCloudinary(coverImageLocalPath)

    if(!coverImage.url){
        throw new ApiError(400, "Error while uploading on cover image")
    }

    const user = await User.findByIdAndUpdate(
        req.user?._id,
        {
            $set: {
                coverImage: coverImage.url
            }
        },
        {new: true}
    ).select("-password")

    return res
    .status(200)
    .json(new ApiResponse(200, user, "Cover Image updated successfully"))
})

const getUserChannelProfile = asyncHandler(async (req, res) => {
    const {username} = req.params

    if(!username?.trim()){
        throw new ApiError(400, "Username is required to get Profile")
    }

    const channel = await User.aggregate([
        {
            $match: {
                username: username?.toLowerCase()
            }
        },
        {
            $lookup: {
                from: "subscriptions",
                localField: "_id",
                foreignField: "channel",
                as: "subscribers"
            }
        },
        {
            $lookup: {
                from: "subscriptions",
                localField: "_id",
                foreignField: "subscriber",
                as: "subscribedTo"
            }
        },
        {
            $addFields: {
                subscribersCount: {
                    $size: "$subscribers" 
                },
                channelsSubscribedToCount: { 
                    $size: "$subscribedTo" 
                },
                isSubscribed: {
                    $cond: {
                        if: {$in: [req.user?._id, "$subscribers.subscriber"]},
                        then: true,
                        else: false
                    }
                }
            }
        },
        {
            $project: {
                fullName: 1,
                username: 1,
                avatar: 1,
                coverImage: 1,
                subscribersCount: 1,
                channelsSubscribedToCount: 1,
                isSubscribed: 1,
                email: 1
            }
        }
    ])

    if(!channel?.length){
        throw new ApiError(404, "Channel not found")
    }

    return res
    .status(200)
    .json(new ApiResponse(200, channel[0], "User Channel Profile Fetched Successfully"))
})

const getWatchHistory = asyncHandler(async (req, res) => {
    // req.user._id is only a string, it is not the actual mongodb id, behind the secne mongoose converts it into the object id

    const user = await User.aggregate([
        {
            $match: {
                _id: new mongoose.Types.ObjectId(req.user._id)
            }
        },
        {
            $lookup: {
                from: "videos",
                localField: "watchHistory",
                foreignField: "_id",
                as: "watchHistory",
                pipeline: [
                    {
                        $lookup: {
                            from: "users",
                            localField: "owner",
                            foreignField: "_id",
                            as: "owner",
                            pipeline: [
                                {
                                    $project: {
                                        fullName: 1,
                                        username: 1,
                                        avatar: 1
                                    }
                                }
                            ]
                        }
                    },
                    {
                        $addFields: {
                            owner: {
                                $first: "$owner"
                            }
                        }
                    }
                ]
            }
        }
    ])

    return res
    .status(200)
    .json(new ApiResponse(200, user[0]?.watchHistory || [], "Watch History Fetched Successfully"))
})

export {
    registerUser, 
    loginUser, 
    logoutUser,
    refreshAccessToken,
    changeCurrentPassword,
    getCurrentUser,
    updateAccountDetails,
    updateUserAvatar,
    updateUserCoverImage,
    getUserChannelProfile,
    getWatchHistory
}