"""
EBS Volume Lifecycle Management Lambda

Manages EBS volumes for CC-on-Bedrock user workspaces.
Actions: create_volume, snapshot_and_detach, restore_from_snapshot, check_user_volume

DynamoDB table "cc-user-volumes" schema:
  PK: user_id (String)
  Attributes: az, volume_id, snapshot_id, s3_path, last_sync, status
"""

import json
import logging
import os
from datetime import datetime
from typing import Any

import boto3
from botocore.exceptions import ClientError

# Configure logging
logger = logging.getLogger()
logger.setLevel(logging.INFO)

# AWS clients
REGION = os.environ.get("AWS_REGION", "ap-northeast-2")
ec2 = boto3.client("ec2", region_name=REGION)
dynamodb = boto3.resource("dynamodb", region_name=REGION)

# DynamoDB table
TABLE_NAME = os.environ.get("DYNAMODB_TABLE", "cc-user-volumes")
table = dynamodb.Table(TABLE_NAME)


def handler(event: dict, context: Any) -> dict:
    """
    Main Lambda handler for EBS lifecycle operations.

    Event format:
    {
        "action": "create_volume" | "snapshot_and_detach" | "restore_from_snapshot" | "check_user_volume",
        "user_id": "user1",
        "az": "ap-northeast-2a",  # Required for create/restore
        "size_gb": 20,            # Optional, default 20
        "volume_id": "vol-xxx"    # Required for snapshot_and_detach
    }
    """
    logger.info(f"Received event: {json.dumps(event)}")

    action = event.get("action")
    user_id = event.get("user_id")

    if not action:
        return error_response(400, "Missing required parameter: action")

    if not user_id:
        return error_response(400, "Missing required parameter: user_id")

    try:
        if action == "create_volume":
            return create_volume(event)
        elif action == "snapshot_and_detach":
            return snapshot_and_detach(event)
        elif action == "restore_from_snapshot":
            return restore_from_snapshot(event)
        elif action == "check_user_volume":
            return check_user_volume(event)
        elif action == "create_and_attach":
            # Alias for create_volume (used by warm-stop resume)
            return create_volume(event)
        elif action == "modify_volume" or action == "modify-volume":
            return modify_volume(event)
        else:
            return error_response(400, f"Unknown action: {action}")
    except ClientError as e:
        logger.error(f"AWS ClientError: {e}")
        return error_response(500, f"AWS error: {e.response['Error']['Message']}")
    except Exception as e:
        logger.error(f"Unexpected error: {e}")
        return error_response(500, f"Internal error: {str(e)}")


def create_volume(event: dict) -> dict:
    """
    Create a new gp3 EBS volume and store metadata in DynamoDB.

    Required: user_id, az
    Optional: size_gb (default 20)
    """
    user_id = event["user_id"]
    az = event.get("az")
    size_gb = event.get("size_gb", 20)

    if not az:
        return error_response(400, "Missing required parameter: az")

    logger.info(f"Creating EBS volume for user {user_id} in {az}, size {size_gb}GB")

    # Create gp3 EBS volume
    response = ec2.create_volume(
        AvailabilityZone=az,
        Size=size_gb,
        VolumeType="gp3",
        Iops=3000,  # gp3 baseline
        Throughput=125,  # gp3 baseline MB/s
        TagSpecifications=[
            {
                "ResourceType": "volume",
                "Tags": [
                    {"Key": "Name", "Value": f"cc-user-{user_id}"},
                    {"Key": "user_id", "Value": user_id},
                    {"Key": "managed_by", "Value": "cc-on-bedrock"},
                    {"Key": "created_at", "Value": datetime.utcnow().isoformat()},
                ]
            }
        ]
    )

    volume_id = response["VolumeId"]
    logger.info(f"Created volume {volume_id} for user {user_id}")

    # Wait for volume to be available
    waiter = ec2.get_waiter("volume_available")
    waiter.wait(VolumeIds=[volume_id], WaiterConfig={"Delay": 5, "MaxAttempts": 24})

    # Store in DynamoDB
    timestamp = datetime.utcnow().isoformat()
    table.put_item(
        Item={
            "user_id": user_id,
            "az": az,
            "volume_id": volume_id,
            "snapshot_id": None,
            "s3_path": None,
            "last_sync": timestamp,
            "status": "available",
            "size_gb": size_gb,
            "created_at": timestamp,
            "updated_at": timestamp,
        }
    )

    logger.info(f"Stored volume metadata in DynamoDB for user {user_id}")

    return success_response({
        "volume_id": volume_id,
        "az": az,
        "size_gb": size_gb,
        "status": "available",
    })


def snapshot_and_detach(event: dict) -> dict:
    """
    Create snapshot from volume, store snapshot_id, then delete volume.

    Required: user_id
    Optional: volume_id (if not provided, looks up from DynamoDB)
    """
    user_id = event["user_id"]
    volume_id = event.get("volume_id")

    # Get volume_id from DynamoDB if not provided
    if not volume_id:
        item = get_user_volume_record(user_id)
        if not item:
            return error_response(404, f"No volume record found for user {user_id}")
        volume_id = item.get("volume_id")
        if not volume_id:
            return error_response(404, f"No active volume for user {user_id}")

    logger.info(f"Creating snapshot for volume {volume_id} (user {user_id})")

    # Create snapshot
    snapshot_response = ec2.create_snapshot(
        VolumeId=volume_id,
        Description=f"CC-on-Bedrock snapshot for user {user_id}",
        TagSpecifications=[
            {
                "ResourceType": "snapshot",
                "Tags": [
                    {"Key": "Name", "Value": f"cc-user-{user_id}-snapshot"},
                    {"Key": "user_id", "Value": user_id},
                    {"Key": "managed_by", "Value": "cc-on-bedrock"},
                    {"Key": "source_volume", "Value": volume_id},
                    {"Key": "created_at", "Value": datetime.utcnow().isoformat()},
                ]
            }
        ]
    )

    snapshot_id = snapshot_response["SnapshotId"]
    logger.info(f"Created snapshot {snapshot_id}")

    # Wait for snapshot to complete
    waiter = ec2.get_waiter("snapshot_completed")
    waiter.wait(SnapshotIds=[snapshot_id], WaiterConfig={"Delay": 15, "MaxAttempts": 120})

    logger.info(f"Snapshot {snapshot_id} completed, deleting volume {volume_id}")

    # Delete volume — may already be gone if ECS deleteOnTermination=true
    try:
        ec2.delete_volume(VolumeId=volume_id)
        logger.info(f"Deleted volume {volume_id}")
    except ClientError as e:
        if e.response["Error"]["Code"] == "InvalidVolume.NotFound":
            logger.info(f"Volume {volume_id} already deleted (ECS deleteOnTermination)")
        else:
            logger.warning(f"Volume {volume_id} deletion failed: {e}")

    # Update DynamoDB
    timestamp = datetime.utcnow().isoformat()
    table.update_item(
        Key={"user_id": user_id},
        UpdateExpression="SET snapshot_id = :sid, volume_id = :vid, #st = :status, updated_at = :ts",
        ExpressionAttributeNames={"#st": "status"},
        ExpressionAttributeValues={
            ":sid": snapshot_id,
            ":vid": None,
            ":status": "snapshot_stored",
            ":ts": timestamp,
        }
    )

    logger.info(f"Updated DynamoDB: volume deleted, snapshot stored")

    return success_response({
        "snapshot_id": snapshot_id,
        "previous_volume_id": volume_id,
        "status": "snapshot_stored",
    })


def restore_from_snapshot(event: dict) -> dict:
    """
    Create volume from snapshot in specified AZ.

    Required: user_id, az
    Optional: snapshot_id (if not provided, looks up from DynamoDB)
    """
    user_id = event["user_id"]
    az = event.get("az")
    snapshot_id = event.get("snapshot_id")

    if not az:
        return error_response(400, "Missing required parameter: az")

    # Get snapshot_id from DynamoDB if not provided
    if not snapshot_id:
        item = get_user_volume_record(user_id)
        if not item:
            return error_response(404, f"No volume record found for user {user_id}")
        snapshot_id = item.get("snapshot_id")
        if not snapshot_id:
            return error_response(404, f"No snapshot found for user {user_id}")

    logger.info(f"Restoring volume from snapshot {snapshot_id} in {az} (user {user_id})")

    # Get snapshot info to determine size
    snapshot_info = ec2.describe_snapshots(SnapshotIds=[snapshot_id])
    size_gb = snapshot_info["Snapshots"][0]["VolumeSize"]

    # Create volume from snapshot
    response = ec2.create_volume(
        AvailabilityZone=az,
        SnapshotId=snapshot_id,
        VolumeType="gp3",
        Iops=3000,
        Throughput=125,
        TagSpecifications=[
            {
                "ResourceType": "volume",
                "Tags": [
                    {"Key": "Name", "Value": f"cc-user-{user_id}"},
                    {"Key": "user_id", "Value": user_id},
                    {"Key": "managed_by", "Value": "cc-on-bedrock"},
                    {"Key": "restored_from", "Value": snapshot_id},
                    {"Key": "created_at", "Value": datetime.utcnow().isoformat()},
                ]
            }
        ]
    )

    volume_id = response["VolumeId"]
    logger.info(f"Created volume {volume_id} from snapshot {snapshot_id}")

    # Wait for volume to be available
    waiter = ec2.get_waiter("volume_available")
    waiter.wait(VolumeIds=[volume_id], WaiterConfig={"Delay": 5, "MaxAttempts": 24})

    # Update DynamoDB
    timestamp = datetime.utcnow().isoformat()
    table.update_item(
        Key={"user_id": user_id},
        UpdateExpression="SET volume_id = :vid, az = :az, #st = :status, updated_at = :ts",
        ExpressionAttributeNames={"#st": "status"},
        ExpressionAttributeValues={
            ":vid": volume_id,
            ":az": az,
            ":status": "available",
            ":ts": timestamp,
        }
    )

    logger.info(f"Updated DynamoDB: volume restored")

    return success_response({
        "volume_id": volume_id,
        "snapshot_id": snapshot_id,
        "az": az,
        "size_gb": size_gb,
        "status": "available",
    })


def check_user_volume(event: dict) -> dict:
    """
    Look up user's current volume status from DynamoDB.

    Required: user_id
    """
    user_id = event["user_id"]

    logger.info(f"Checking volume status for user {user_id}")

    item = get_user_volume_record(user_id)

    if not item:
        return success_response({
            "user_id": user_id,
            "status": "not_found",
            "message": "No volume record found for this user",
        })

    # If there's an active volume, verify it still exists
    volume_id = item.get("volume_id")
    if volume_id:
        try:
            vol_response = ec2.describe_volumes(VolumeIds=[volume_id])
            if vol_response["Volumes"]:
                vol_state = vol_response["Volumes"][0]["State"]
                item["volume_state"] = vol_state
        except ClientError as e:
            if e.response["Error"]["Code"] == "InvalidVolume.NotFound":
                logger.warning(f"Volume {volume_id} not found, updating record")
                # Volume was deleted externally, update record
                table.update_item(
                    Key={"user_id": user_id},
                    UpdateExpression="SET volume_id = :vid, #st = :status, updated_at = :ts",
                    ExpressionAttributeNames={"#st": "status"},
                    ExpressionAttributeValues={
                        ":vid": None,
                        ":status": "volume_missing",
                        ":ts": datetime.utcnow().isoformat(),
                    }
                )
                item["volume_id"] = None
                item["status"] = "volume_missing"
            else:
                raise

    return success_response(item)


def get_user_volume_record(user_id: str) -> dict | None:
    """Get user's volume record from DynamoDB."""
    try:
        response = table.get_item(Key={"user_id": user_id})
        return response.get("Item")
    except ClientError as e:
        logger.error(f"DynamoDB error: {e}")
        return None


def modify_volume(event: dict) -> dict:
    """
    Modify an existing EBS volume size (for admin-approved resize).

    Required: user_id, requested_size_gb
    Note: EBS volumes have a 6-hour cooldown between modifications.
    """
    user_id = event["user_id"]
    requested_size_gb = event.get("requested_size_gb", event.get("requestedSizeGb"))

    if not requested_size_gb:
        return error_response(400, "Missing required parameter: requested_size_gb")

    requested_size_gb = int(requested_size_gb)

    # Get current volume info from DynamoDB
    result = table.get_item(Key={"user_id": user_id})
    item = result.get("Item")
    if not item:
        return error_response(404, f"No volume record found for user {user_id}")

    volume_id = item.get("volume_id")
    if not volume_id:
        # No active volume — just update the size in DynamoDB for next start
        timestamp = datetime.utcnow().isoformat()
        table.update_item(
            Key={"user_id": user_id},
            UpdateExpression="SET currentSizeGb = :size, size_gb = :size, updated_at = :ts",
            ExpressionAttributeValues={
                ":size": requested_size_gb,
                ":ts": timestamp,
            },
        )
        return success_response({
            "user_id": user_id,
            "action": "modify_volume",
            "status": "size_updated_for_next_start",
            "new_size_gb": requested_size_gb,
        })

    # Check if volume exists and is modifiable
    try:
        vol_desc = ec2.describe_volumes(VolumeIds=[volume_id])
        current_size = vol_desc["Volumes"][0]["Size"]
    except ClientError as e:
        if e.response["Error"]["Code"] == "InvalidVolume.NotFound":
            # Volume doesn't exist — update DynamoDB size for next start
            timestamp = datetime.utcnow().isoformat()
            table.update_item(
                Key={"user_id": user_id},
                UpdateExpression="SET currentSizeGb = :size, size_gb = :size, updated_at = :ts, volume_id = :null",
                ExpressionAttributeValues={
                    ":size": requested_size_gb,
                    ":ts": timestamp,
                    ":null": None,
                },
            )
            return success_response({
                "user_id": user_id,
                "action": "modify_volume",
                "status": "volume_gone_size_updated",
                "new_size_gb": requested_size_gb,
            })
        raise

    if requested_size_gb <= current_size:
        return error_response(400, f"Requested size ({requested_size_gb}GB) must be larger than current ({current_size}GB)")

    logger.info(f"Modifying volume {volume_id} from {current_size}GB to {requested_size_gb}GB")

    # Modify the volume
    ec2.modify_volume(
        VolumeId=volume_id,
        Size=requested_size_gb,
    )

    # Update DynamoDB
    timestamp = datetime.utcnow().isoformat()
    table.update_item(
        Key={"user_id": user_id},
        UpdateExpression="SET currentSizeGb = :size, size_gb = :size, updated_at = :ts",
        ExpressionAttributeValues={
            ":size": requested_size_gb,
            ":ts": timestamp,
        },
    )

    logger.info(f"Volume {volume_id} resize initiated: {current_size}GB -> {requested_size_gb}GB")

    return success_response({
        "user_id": user_id,
        "action": "modify_volume",
        "volume_id": volume_id,
        "old_size_gb": current_size,
        "new_size_gb": requested_size_gb,
        "status": "modifying",
    })


def success_response(data: dict) -> dict:
    """Return success response."""
    return {
        "statusCode": 200,
        "body": json.dumps(data),
    }


def error_response(status_code: int, message: str) -> dict:
    """Return error response."""
    return {
        "statusCode": status_code,
        "body": json.dumps({"error": message}),
    }
