# Podcast Pingback Receiver Lambda Function

A minimum viable [Podcast Pingback](https://podping.info/) receiver suitable for
deployment as an [AWS Lambda](https://aws.amazon.com/lambda/) function.

The function parses and validates an incoming submission against the [Podcast
Pingback v1](https://podping.info/specification/1) specification and, if valid,
saves the incoming request in to an [S3 bucket](https://aws.amazon.com/s3/).

The contents of the bucket can then be processed by an independent process to
interpret the submissions as your organisation requires.

This is intended to remain a minimal implementation for demonstration purposes.

## Installation

```
$ npm install @aiir\podcast-pingback-lambda
```

## Methodology

The Lambda function will save all valid incoming requests to an S3 bucket. The
body will be the original JSON object that was received and it's key is made up
of the date and time of the incoming request and the first component of the
listener's UUID.

If a `listener` object is included in the request, the `listener_token` value
returned in the response is a
[JSON Web Token](https://tools.ietf.org/html/rfc7519) which includes the
listener's UUID, encoded using the secret supplied to the Lambda function.

For example, with the function configured with a secret of `MySpecialSecret`, an
incoming request of:

```
POST /pingback HTTP/1.1
Content-Type: application/json
Date: Mon, 8 Oct 2018 08:17:22 GMT

{ "uuid": "2eefaf08-d43e-46f9-ac53-520c881e59b8",
  "content": "https://alice.example.net/episode-1.mp3",
  "listener": {
    "date_of_birth": "1984-11-21"
  },
  "events": [
    {
      "event": "resume",
      "date": "2018-01-01T09:00:00Z",
      "offset": 0
    }
  ]
}
```

would elicit the response:

```
HTTP/1.1 201 Created
Content-Type: application/json
Date: Mon, 8 Oct 2018 08:17:22 GMT

{ "status": "ok",
  "listener_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1dWlkIjoiMmVlZmFmMDgtZDQzZS00NmY5LWFjNTMtNTIwYzg4MWU1OWI4In0.vgUQ_HS7EwswfmXkD4f0koUBcrCmiiv0hkkcacY3oCc"
}
```

An object with the key `2018-10-08-08:17:22-2eefaf08.json` would be written to
the S3 bucket, with the same body as the request:

```
{ "uuid": "2eefaf08-d43e-46f9-ac53-520c881e59b8",
  "content": "https://alice.example.net/episode-1.mp3",
  "listener": {
    "date_of_birth": "1984-11-21"
  },
  "events": [
    {
      "event": "resume",
      "date": "2018-01-01T09:00:00Z",
      "offset": 0
    }
  ]
}
```

## Deployment

### Using CloudFormation

The easiest way to get started is to use the supplied
[CloudFormation](https://aws.amazon.com/cloudformation/) script, which sets up
the required AWS components for you.

This may not be desirable for your environment as it uses AWS defaults and
creates fresh resources for all the required components, where you may already
have some of the required infastructure setup. Always be sure to check what's
involved in a CloudFormation script before deploying it in to your environment.

1. From the same directory you installed this Node.js module in to, run the
   package process to create a zip file suitable for upload to AWS:

   ```
   $ npm run package
   ```

   This creates a `lambda-package` directory which contains the minimum required
   files for the Lambda function, removing unnecessary files that exist in the
   root of the project to keep the Lambda function package lean.

2. Ensuring you have the [AWS CLI](https://aws.amazon.com/cli/) installed, run
   the following command to upload the local function package to an S3 bucket of
   your choosing and regenerate the template with the S3 URL injected, ready for
   deployment.

   Be sure to replace `my-bucket` with name of a bucket your current AWS profile
   has write access to. This is a temporary location for the code before Lambda
   deployment takes a copy of it, so you can delete it later and don't
   necessarily need a bespoke bucket for. This is also not the bucket requests
   will be saved to, that is automatically created later by the CloudFormation.

   ```
   aws cloudformation package \
       --template template.json \
       --s3-bucket my-bucket \
       --output-template-file packaged-template.json \
       --use-json
   ```

3. Once complete, you now need to request CloudFormation deploy the stack which
   will create the AWS components and deploy the receiver ready for use.

   Be sure to replace `MySecret` with a good 512-byte secret, which will be used
   by function to encrypt a listener token.

   The `--capabilities CAPABILITY_IAM` line gives permission for this
   CloudFormation template to create IAM roles. This is used by the template to
   allow the Lambda function write access to only the S3 bucket it creates for
   storing incoming requests.

   ```
   aws cloudformation deploy \
       --template-file packaged-template.json \
       --stack-name podcast-pingback-stack \
       --parameter-overrides TokenSecret=MySecret \
       --capabilities CAPABILITY_IAM
   ```

4. When this finishes successfully, you will have an HTTPS accessible Podcast
   Pingback receiver.

   To find the public URL for your receiver, visit the
   [AWS Console](https://console.aws.amazon.com/console/), then go to API
   Gateway, find the specific gateway for this project (usually part of the name
   will include `podcast-pingback-stack` unless you chose an alternative stack
   name in Step 3), then going to Stages, then `Prod`.

   On this page you will see the root URL for the stage (e.g.
   `https://e9cddzz12i.execute-api.eu-west-1.amazonaws.com/Prod`). Add the
   resource path `/receiver` to the end for the specific resource to get the
   full URL.

   API Gateway offers the ability to replace this default host + stage with a
   [custom domain](https://docs.aws.amazon.com/apigateway/latest/developerguide/how-to-custom-domains.html),
   which gives you a better looking receiver URL.

5. Finally, don't forget to advertise your Podcast Pingback receiver URL in the
   RSS feed(s) of your podcast(s). This is done by adding the following line
   within your <pingback:receiver> element.

   ```
   <pingback:receiver>https://e9cddzz12i.execute-api.eu-west-1.amazonaws.com/Prod/receiver</pingback:receiver>
   ```

### Manually

If you'd prefer to integrate this script in to an established AWS environment,
or perform the steps manually, you will need to setup the Lambda function, an S3
bucket for storing incoming requests, a role to allow the function to write to
the S3 bucket, and an API Gateway to allow HTTPS access to the function.

The function itself requires a Node 8.10 runtime, and the following environment
variables to be configured:

<dl>
  <dt><code>SECRET</code></dt>
  <dd>
    The function generates JSON Web Tokens to identify unique clients. It
    requires a "secret" to encode the contents. Set to a random, long string.
  </dd>
  <dt><code>BUCKET</code></dt>
  <dd>
    This is the name of the bucket you created in Step 1, so the function knows
    where to dump valid requests.
  </dd>
</dl>

## Authors

- Created by [@andybee](https://twitter.com/andybee)

## License

MIT
