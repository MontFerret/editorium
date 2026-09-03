package org.ferretlang.jetbrains.protocol.ferretd.execution.v1;

import static io.grpc.MethodDescriptor.generateFullMethodName;

/**
 */
@io.grpc.stub.annotations.GrpcGenerated
public final class ExecutionServiceGrpc {

  private ExecutionServiceGrpc() {}

  public static final java.lang.String SERVICE_NAME = "ferretd.execution.v1.ExecutionService";

  // Static method descriptors that strictly reflect the proto.
  private static volatile io.grpc.MethodDescriptor<org.ferretlang.jetbrains.protocol.ferretd.execution.v1.CreateSessionRequest,
      org.ferretlang.jetbrains.protocol.ferretd.execution.v1.CreateSessionResponse> getCreateSessionMethod;

  @io.grpc.stub.annotations.RpcMethod(
      fullMethodName = SERVICE_NAME + '/' + "CreateSession",
      requestType = org.ferretlang.jetbrains.protocol.ferretd.execution.v1.CreateSessionRequest.class,
      responseType = org.ferretlang.jetbrains.protocol.ferretd.execution.v1.CreateSessionResponse.class,
      methodType = io.grpc.MethodDescriptor.MethodType.UNARY)
  public static io.grpc.MethodDescriptor<org.ferretlang.jetbrains.protocol.ferretd.execution.v1.CreateSessionRequest,
      org.ferretlang.jetbrains.protocol.ferretd.execution.v1.CreateSessionResponse> getCreateSessionMethod() {
    io.grpc.MethodDescriptor<org.ferretlang.jetbrains.protocol.ferretd.execution.v1.CreateSessionRequest, org.ferretlang.jetbrains.protocol.ferretd.execution.v1.CreateSessionResponse> getCreateSessionMethod;
    if ((getCreateSessionMethod = ExecutionServiceGrpc.getCreateSessionMethod) == null) {
      synchronized (ExecutionServiceGrpc.class) {
        if ((getCreateSessionMethod = ExecutionServiceGrpc.getCreateSessionMethod) == null) {
          ExecutionServiceGrpc.getCreateSessionMethod = getCreateSessionMethod =
              io.grpc.MethodDescriptor.<org.ferretlang.jetbrains.protocol.ferretd.execution.v1.CreateSessionRequest, org.ferretlang.jetbrains.protocol.ferretd.execution.v1.CreateSessionResponse>newBuilder()
              .setType(io.grpc.MethodDescriptor.MethodType.UNARY)
              .setFullMethodName(generateFullMethodName(SERVICE_NAME, "CreateSession"))
              .setSampledToLocalTracing(true)
              .setRequestMarshaller(io.grpc.protobuf.ProtoUtils.marshaller(
                  org.ferretlang.jetbrains.protocol.ferretd.execution.v1.CreateSessionRequest.getDefaultInstance()))
              .setResponseMarshaller(io.grpc.protobuf.ProtoUtils.marshaller(
                  org.ferretlang.jetbrains.protocol.ferretd.execution.v1.CreateSessionResponse.getDefaultInstance()))
              .setSchemaDescriptor(new ExecutionServiceMethodDescriptorSupplier("CreateSession"))
              .build();
        }
      }
    }
    return getCreateSessionMethod;
  }

  private static volatile io.grpc.MethodDescriptor<org.ferretlang.jetbrains.protocol.ferretd.execution.v1.GetSessionRequest,
      org.ferretlang.jetbrains.protocol.ferretd.execution.v1.GetSessionResponse> getGetSessionMethod;

  @io.grpc.stub.annotations.RpcMethod(
      fullMethodName = SERVICE_NAME + '/' + "GetSession",
      requestType = org.ferretlang.jetbrains.protocol.ferretd.execution.v1.GetSessionRequest.class,
      responseType = org.ferretlang.jetbrains.protocol.ferretd.execution.v1.GetSessionResponse.class,
      methodType = io.grpc.MethodDescriptor.MethodType.UNARY)
  public static io.grpc.MethodDescriptor<org.ferretlang.jetbrains.protocol.ferretd.execution.v1.GetSessionRequest,
      org.ferretlang.jetbrains.protocol.ferretd.execution.v1.GetSessionResponse> getGetSessionMethod() {
    io.grpc.MethodDescriptor<org.ferretlang.jetbrains.protocol.ferretd.execution.v1.GetSessionRequest, org.ferretlang.jetbrains.protocol.ferretd.execution.v1.GetSessionResponse> getGetSessionMethod;
    if ((getGetSessionMethod = ExecutionServiceGrpc.getGetSessionMethod) == null) {
      synchronized (ExecutionServiceGrpc.class) {
        if ((getGetSessionMethod = ExecutionServiceGrpc.getGetSessionMethod) == null) {
          ExecutionServiceGrpc.getGetSessionMethod = getGetSessionMethod =
              io.grpc.MethodDescriptor.<org.ferretlang.jetbrains.protocol.ferretd.execution.v1.GetSessionRequest, org.ferretlang.jetbrains.protocol.ferretd.execution.v1.GetSessionResponse>newBuilder()
              .setType(io.grpc.MethodDescriptor.MethodType.UNARY)
              .setFullMethodName(generateFullMethodName(SERVICE_NAME, "GetSession"))
              .setSampledToLocalTracing(true)
              .setRequestMarshaller(io.grpc.protobuf.ProtoUtils.marshaller(
                  org.ferretlang.jetbrains.protocol.ferretd.execution.v1.GetSessionRequest.getDefaultInstance()))
              .setResponseMarshaller(io.grpc.protobuf.ProtoUtils.marshaller(
                  org.ferretlang.jetbrains.protocol.ferretd.execution.v1.GetSessionResponse.getDefaultInstance()))
              .setSchemaDescriptor(new ExecutionServiceMethodDescriptorSupplier("GetSession"))
              .build();
        }
      }
    }
    return getGetSessionMethod;
  }

  private static volatile io.grpc.MethodDescriptor<org.ferretlang.jetbrains.protocol.ferretd.execution.v1.CloseSessionRequest,
      org.ferretlang.jetbrains.protocol.ferretd.execution.v1.CloseSessionResponse> getCloseSessionMethod;

  @io.grpc.stub.annotations.RpcMethod(
      fullMethodName = SERVICE_NAME + '/' + "CloseSession",
      requestType = org.ferretlang.jetbrains.protocol.ferretd.execution.v1.CloseSessionRequest.class,
      responseType = org.ferretlang.jetbrains.protocol.ferretd.execution.v1.CloseSessionResponse.class,
      methodType = io.grpc.MethodDescriptor.MethodType.UNARY)
  public static io.grpc.MethodDescriptor<org.ferretlang.jetbrains.protocol.ferretd.execution.v1.CloseSessionRequest,
      org.ferretlang.jetbrains.protocol.ferretd.execution.v1.CloseSessionResponse> getCloseSessionMethod() {
    io.grpc.MethodDescriptor<org.ferretlang.jetbrains.protocol.ferretd.execution.v1.CloseSessionRequest, org.ferretlang.jetbrains.protocol.ferretd.execution.v1.CloseSessionResponse> getCloseSessionMethod;
    if ((getCloseSessionMethod = ExecutionServiceGrpc.getCloseSessionMethod) == null) {
      synchronized (ExecutionServiceGrpc.class) {
        if ((getCloseSessionMethod = ExecutionServiceGrpc.getCloseSessionMethod) == null) {
          ExecutionServiceGrpc.getCloseSessionMethod = getCloseSessionMethod =
              io.grpc.MethodDescriptor.<org.ferretlang.jetbrains.protocol.ferretd.execution.v1.CloseSessionRequest, org.ferretlang.jetbrains.protocol.ferretd.execution.v1.CloseSessionResponse>newBuilder()
              .setType(io.grpc.MethodDescriptor.MethodType.UNARY)
              .setFullMethodName(generateFullMethodName(SERVICE_NAME, "CloseSession"))
              .setSampledToLocalTracing(true)
              .setRequestMarshaller(io.grpc.protobuf.ProtoUtils.marshaller(
                  org.ferretlang.jetbrains.protocol.ferretd.execution.v1.CloseSessionRequest.getDefaultInstance()))
              .setResponseMarshaller(io.grpc.protobuf.ProtoUtils.marshaller(
                  org.ferretlang.jetbrains.protocol.ferretd.execution.v1.CloseSessionResponse.getDefaultInstance()))
              .setSchemaDescriptor(new ExecutionServiceMethodDescriptorSupplier("CloseSession"))
              .build();
        }
      }
    }
    return getCloseSessionMethod;
  }

  private static volatile io.grpc.MethodDescriptor<org.ferretlang.jetbrains.protocol.ferretd.execution.v1.CreateExecutionRequest,
      org.ferretlang.jetbrains.protocol.ferretd.execution.v1.CreateExecutionResponse> getCreateExecutionMethod;

  @io.grpc.stub.annotations.RpcMethod(
      fullMethodName = SERVICE_NAME + '/' + "CreateExecution",
      requestType = org.ferretlang.jetbrains.protocol.ferretd.execution.v1.CreateExecutionRequest.class,
      responseType = org.ferretlang.jetbrains.protocol.ferretd.execution.v1.CreateExecutionResponse.class,
      methodType = io.grpc.MethodDescriptor.MethodType.UNARY)
  public static io.grpc.MethodDescriptor<org.ferretlang.jetbrains.protocol.ferretd.execution.v1.CreateExecutionRequest,
      org.ferretlang.jetbrains.protocol.ferretd.execution.v1.CreateExecutionResponse> getCreateExecutionMethod() {
    io.grpc.MethodDescriptor<org.ferretlang.jetbrains.protocol.ferretd.execution.v1.CreateExecutionRequest, org.ferretlang.jetbrains.protocol.ferretd.execution.v1.CreateExecutionResponse> getCreateExecutionMethod;
    if ((getCreateExecutionMethod = ExecutionServiceGrpc.getCreateExecutionMethod) == null) {
      synchronized (ExecutionServiceGrpc.class) {
        if ((getCreateExecutionMethod = ExecutionServiceGrpc.getCreateExecutionMethod) == null) {
          ExecutionServiceGrpc.getCreateExecutionMethod = getCreateExecutionMethod =
              io.grpc.MethodDescriptor.<org.ferretlang.jetbrains.protocol.ferretd.execution.v1.CreateExecutionRequest, org.ferretlang.jetbrains.protocol.ferretd.execution.v1.CreateExecutionResponse>newBuilder()
              .setType(io.grpc.MethodDescriptor.MethodType.UNARY)
              .setFullMethodName(generateFullMethodName(SERVICE_NAME, "CreateExecution"))
              .setSampledToLocalTracing(true)
              .setRequestMarshaller(io.grpc.protobuf.ProtoUtils.marshaller(
                  org.ferretlang.jetbrains.protocol.ferretd.execution.v1.CreateExecutionRequest.getDefaultInstance()))
              .setResponseMarshaller(io.grpc.protobuf.ProtoUtils.marshaller(
                  org.ferretlang.jetbrains.protocol.ferretd.execution.v1.CreateExecutionResponse.getDefaultInstance()))
              .setSchemaDescriptor(new ExecutionServiceMethodDescriptorSupplier("CreateExecution"))
              .build();
        }
      }
    }
    return getCreateExecutionMethod;
  }

  private static volatile io.grpc.MethodDescriptor<org.ferretlang.jetbrains.protocol.ferretd.execution.v1.RunExecutionRequest,
      org.ferretlang.jetbrains.protocol.ferretd.execution.v1.RunExecutionResponse> getRunExecutionMethod;

  @io.grpc.stub.annotations.RpcMethod(
      fullMethodName = SERVICE_NAME + '/' + "RunExecution",
      requestType = org.ferretlang.jetbrains.protocol.ferretd.execution.v1.RunExecutionRequest.class,
      responseType = org.ferretlang.jetbrains.protocol.ferretd.execution.v1.RunExecutionResponse.class,
      methodType = io.grpc.MethodDescriptor.MethodType.UNARY)
  public static io.grpc.MethodDescriptor<org.ferretlang.jetbrains.protocol.ferretd.execution.v1.RunExecutionRequest,
      org.ferretlang.jetbrains.protocol.ferretd.execution.v1.RunExecutionResponse> getRunExecutionMethod() {
    io.grpc.MethodDescriptor<org.ferretlang.jetbrains.protocol.ferretd.execution.v1.RunExecutionRequest, org.ferretlang.jetbrains.protocol.ferretd.execution.v1.RunExecutionResponse> getRunExecutionMethod;
    if ((getRunExecutionMethod = ExecutionServiceGrpc.getRunExecutionMethod) == null) {
      synchronized (ExecutionServiceGrpc.class) {
        if ((getRunExecutionMethod = ExecutionServiceGrpc.getRunExecutionMethod) == null) {
          ExecutionServiceGrpc.getRunExecutionMethod = getRunExecutionMethod =
              io.grpc.MethodDescriptor.<org.ferretlang.jetbrains.protocol.ferretd.execution.v1.RunExecutionRequest, org.ferretlang.jetbrains.protocol.ferretd.execution.v1.RunExecutionResponse>newBuilder()
              .setType(io.grpc.MethodDescriptor.MethodType.UNARY)
              .setFullMethodName(generateFullMethodName(SERVICE_NAME, "RunExecution"))
              .setSampledToLocalTracing(true)
              .setRequestMarshaller(io.grpc.protobuf.ProtoUtils.marshaller(
                  org.ferretlang.jetbrains.protocol.ferretd.execution.v1.RunExecutionRequest.getDefaultInstance()))
              .setResponseMarshaller(io.grpc.protobuf.ProtoUtils.marshaller(
                  org.ferretlang.jetbrains.protocol.ferretd.execution.v1.RunExecutionResponse.getDefaultInstance()))
              .setSchemaDescriptor(new ExecutionServiceMethodDescriptorSupplier("RunExecution"))
              .build();
        }
      }
    }
    return getRunExecutionMethod;
  }

  private static volatile io.grpc.MethodDescriptor<org.ferretlang.jetbrains.protocol.ferretd.execution.v1.GetExecutionRequest,
      org.ferretlang.jetbrains.protocol.ferretd.execution.v1.GetExecutionResponse> getGetExecutionMethod;

  @io.grpc.stub.annotations.RpcMethod(
      fullMethodName = SERVICE_NAME + '/' + "GetExecution",
      requestType = org.ferretlang.jetbrains.protocol.ferretd.execution.v1.GetExecutionRequest.class,
      responseType = org.ferretlang.jetbrains.protocol.ferretd.execution.v1.GetExecutionResponse.class,
      methodType = io.grpc.MethodDescriptor.MethodType.UNARY)
  public static io.grpc.MethodDescriptor<org.ferretlang.jetbrains.protocol.ferretd.execution.v1.GetExecutionRequest,
      org.ferretlang.jetbrains.protocol.ferretd.execution.v1.GetExecutionResponse> getGetExecutionMethod() {
    io.grpc.MethodDescriptor<org.ferretlang.jetbrains.protocol.ferretd.execution.v1.GetExecutionRequest, org.ferretlang.jetbrains.protocol.ferretd.execution.v1.GetExecutionResponse> getGetExecutionMethod;
    if ((getGetExecutionMethod = ExecutionServiceGrpc.getGetExecutionMethod) == null) {
      synchronized (ExecutionServiceGrpc.class) {
        if ((getGetExecutionMethod = ExecutionServiceGrpc.getGetExecutionMethod) == null) {
          ExecutionServiceGrpc.getGetExecutionMethod = getGetExecutionMethod =
              io.grpc.MethodDescriptor.<org.ferretlang.jetbrains.protocol.ferretd.execution.v1.GetExecutionRequest, org.ferretlang.jetbrains.protocol.ferretd.execution.v1.GetExecutionResponse>newBuilder()
              .setType(io.grpc.MethodDescriptor.MethodType.UNARY)
              .setFullMethodName(generateFullMethodName(SERVICE_NAME, "GetExecution"))
              .setSampledToLocalTracing(true)
              .setRequestMarshaller(io.grpc.protobuf.ProtoUtils.marshaller(
                  org.ferretlang.jetbrains.protocol.ferretd.execution.v1.GetExecutionRequest.getDefaultInstance()))
              .setResponseMarshaller(io.grpc.protobuf.ProtoUtils.marshaller(
                  org.ferretlang.jetbrains.protocol.ferretd.execution.v1.GetExecutionResponse.getDefaultInstance()))
              .setSchemaDescriptor(new ExecutionServiceMethodDescriptorSupplier("GetExecution"))
              .build();
        }
      }
    }
    return getGetExecutionMethod;
  }

  private static volatile io.grpc.MethodDescriptor<org.ferretlang.jetbrains.protocol.ferretd.execution.v1.CancelExecutionRequest,
      org.ferretlang.jetbrains.protocol.ferretd.execution.v1.CancelExecutionResponse> getCancelExecutionMethod;

  @io.grpc.stub.annotations.RpcMethod(
      fullMethodName = SERVICE_NAME + '/' + "CancelExecution",
      requestType = org.ferretlang.jetbrains.protocol.ferretd.execution.v1.CancelExecutionRequest.class,
      responseType = org.ferretlang.jetbrains.protocol.ferretd.execution.v1.CancelExecutionResponse.class,
      methodType = io.grpc.MethodDescriptor.MethodType.UNARY)
  public static io.grpc.MethodDescriptor<org.ferretlang.jetbrains.protocol.ferretd.execution.v1.CancelExecutionRequest,
      org.ferretlang.jetbrains.protocol.ferretd.execution.v1.CancelExecutionResponse> getCancelExecutionMethod() {
    io.grpc.MethodDescriptor<org.ferretlang.jetbrains.protocol.ferretd.execution.v1.CancelExecutionRequest, org.ferretlang.jetbrains.protocol.ferretd.execution.v1.CancelExecutionResponse> getCancelExecutionMethod;
    if ((getCancelExecutionMethod = ExecutionServiceGrpc.getCancelExecutionMethod) == null) {
      synchronized (ExecutionServiceGrpc.class) {
        if ((getCancelExecutionMethod = ExecutionServiceGrpc.getCancelExecutionMethod) == null) {
          ExecutionServiceGrpc.getCancelExecutionMethod = getCancelExecutionMethod =
              io.grpc.MethodDescriptor.<org.ferretlang.jetbrains.protocol.ferretd.execution.v1.CancelExecutionRequest, org.ferretlang.jetbrains.protocol.ferretd.execution.v1.CancelExecutionResponse>newBuilder()
              .setType(io.grpc.MethodDescriptor.MethodType.UNARY)
              .setFullMethodName(generateFullMethodName(SERVICE_NAME, "CancelExecution"))
              .setSampledToLocalTracing(true)
              .setRequestMarshaller(io.grpc.protobuf.ProtoUtils.marshaller(
                  org.ferretlang.jetbrains.protocol.ferretd.execution.v1.CancelExecutionRequest.getDefaultInstance()))
              .setResponseMarshaller(io.grpc.protobuf.ProtoUtils.marshaller(
                  org.ferretlang.jetbrains.protocol.ferretd.execution.v1.CancelExecutionResponse.getDefaultInstance()))
              .setSchemaDescriptor(new ExecutionServiceMethodDescriptorSupplier("CancelExecution"))
              .build();
        }
      }
    }
    return getCancelExecutionMethod;
  }

  private static volatile io.grpc.MethodDescriptor<org.ferretlang.jetbrains.protocol.ferretd.execution.v1.CloseExecutionRequest,
      org.ferretlang.jetbrains.protocol.ferretd.execution.v1.CloseExecutionResponse> getCloseExecutionMethod;

  @io.grpc.stub.annotations.RpcMethod(
      fullMethodName = SERVICE_NAME + '/' + "CloseExecution",
      requestType = org.ferretlang.jetbrains.protocol.ferretd.execution.v1.CloseExecutionRequest.class,
      responseType = org.ferretlang.jetbrains.protocol.ferretd.execution.v1.CloseExecutionResponse.class,
      methodType = io.grpc.MethodDescriptor.MethodType.UNARY)
  public static io.grpc.MethodDescriptor<org.ferretlang.jetbrains.protocol.ferretd.execution.v1.CloseExecutionRequest,
      org.ferretlang.jetbrains.protocol.ferretd.execution.v1.CloseExecutionResponse> getCloseExecutionMethod() {
    io.grpc.MethodDescriptor<org.ferretlang.jetbrains.protocol.ferretd.execution.v1.CloseExecutionRequest, org.ferretlang.jetbrains.protocol.ferretd.execution.v1.CloseExecutionResponse> getCloseExecutionMethod;
    if ((getCloseExecutionMethod = ExecutionServiceGrpc.getCloseExecutionMethod) == null) {
      synchronized (ExecutionServiceGrpc.class) {
        if ((getCloseExecutionMethod = ExecutionServiceGrpc.getCloseExecutionMethod) == null) {
          ExecutionServiceGrpc.getCloseExecutionMethod = getCloseExecutionMethod =
              io.grpc.MethodDescriptor.<org.ferretlang.jetbrains.protocol.ferretd.execution.v1.CloseExecutionRequest, org.ferretlang.jetbrains.protocol.ferretd.execution.v1.CloseExecutionResponse>newBuilder()
              .setType(io.grpc.MethodDescriptor.MethodType.UNARY)
              .setFullMethodName(generateFullMethodName(SERVICE_NAME, "CloseExecution"))
              .setSampledToLocalTracing(true)
              .setRequestMarshaller(io.grpc.protobuf.ProtoUtils.marshaller(
                  org.ferretlang.jetbrains.protocol.ferretd.execution.v1.CloseExecutionRequest.getDefaultInstance()))
              .setResponseMarshaller(io.grpc.protobuf.ProtoUtils.marshaller(
                  org.ferretlang.jetbrains.protocol.ferretd.execution.v1.CloseExecutionResponse.getDefaultInstance()))
              .setSchemaDescriptor(new ExecutionServiceMethodDescriptorSupplier("CloseExecution"))
              .build();
        }
      }
    }
    return getCloseExecutionMethod;
  }

  private static volatile io.grpc.MethodDescriptor<org.ferretlang.jetbrains.protocol.ferretd.execution.v1.WatchExecutionRequest,
      org.ferretlang.jetbrains.protocol.ferretd.execution.v1.WatchExecutionResponse> getWatchExecutionMethod;

  @io.grpc.stub.annotations.RpcMethod(
      fullMethodName = SERVICE_NAME + '/' + "WatchExecution",
      requestType = org.ferretlang.jetbrains.protocol.ferretd.execution.v1.WatchExecutionRequest.class,
      responseType = org.ferretlang.jetbrains.protocol.ferretd.execution.v1.WatchExecutionResponse.class,
      methodType = io.grpc.MethodDescriptor.MethodType.SERVER_STREAMING)
  public static io.grpc.MethodDescriptor<org.ferretlang.jetbrains.protocol.ferretd.execution.v1.WatchExecutionRequest,
      org.ferretlang.jetbrains.protocol.ferretd.execution.v1.WatchExecutionResponse> getWatchExecutionMethod() {
    io.grpc.MethodDescriptor<org.ferretlang.jetbrains.protocol.ferretd.execution.v1.WatchExecutionRequest, org.ferretlang.jetbrains.protocol.ferretd.execution.v1.WatchExecutionResponse> getWatchExecutionMethod;
    if ((getWatchExecutionMethod = ExecutionServiceGrpc.getWatchExecutionMethod) == null) {
      synchronized (ExecutionServiceGrpc.class) {
        if ((getWatchExecutionMethod = ExecutionServiceGrpc.getWatchExecutionMethod) == null) {
          ExecutionServiceGrpc.getWatchExecutionMethod = getWatchExecutionMethod =
              io.grpc.MethodDescriptor.<org.ferretlang.jetbrains.protocol.ferretd.execution.v1.WatchExecutionRequest, org.ferretlang.jetbrains.protocol.ferretd.execution.v1.WatchExecutionResponse>newBuilder()
              .setType(io.grpc.MethodDescriptor.MethodType.SERVER_STREAMING)
              .setFullMethodName(generateFullMethodName(SERVICE_NAME, "WatchExecution"))
              .setSampledToLocalTracing(true)
              .setRequestMarshaller(io.grpc.protobuf.ProtoUtils.marshaller(
                  org.ferretlang.jetbrains.protocol.ferretd.execution.v1.WatchExecutionRequest.getDefaultInstance()))
              .setResponseMarshaller(io.grpc.protobuf.ProtoUtils.marshaller(
                  org.ferretlang.jetbrains.protocol.ferretd.execution.v1.WatchExecutionResponse.getDefaultInstance()))
              .setSchemaDescriptor(new ExecutionServiceMethodDescriptorSupplier("WatchExecution"))
              .build();
        }
      }
    }
    return getWatchExecutionMethod;
  }

  /**
   * Creates a new async stub that supports all call types for the service
   */
  public static ExecutionServiceStub newStub(io.grpc.Channel channel) {
    io.grpc.stub.AbstractStub.StubFactory<ExecutionServiceStub> factory =
      new io.grpc.stub.AbstractStub.StubFactory<ExecutionServiceStub>() {
        @java.lang.Override
        public ExecutionServiceStub newStub(io.grpc.Channel channel, io.grpc.CallOptions callOptions) {
          return new ExecutionServiceStub(channel, callOptions);
        }
      };
    return ExecutionServiceStub.newStub(factory, channel);
  }

  /**
   * Creates a new blocking-style stub that supports all types of calls on the service
   */
  public static ExecutionServiceBlockingV2Stub newBlockingV2Stub(
      io.grpc.Channel channel) {
    io.grpc.stub.AbstractStub.StubFactory<ExecutionServiceBlockingV2Stub> factory =
      new io.grpc.stub.AbstractStub.StubFactory<ExecutionServiceBlockingV2Stub>() {
        @java.lang.Override
        public ExecutionServiceBlockingV2Stub newStub(io.grpc.Channel channel, io.grpc.CallOptions callOptions) {
          return new ExecutionServiceBlockingV2Stub(channel, callOptions);
        }
      };
    return ExecutionServiceBlockingV2Stub.newStub(factory, channel);
  }

  /**
   * Creates a new blocking-style stub that supports unary and streaming output calls on the service
   */
  public static ExecutionServiceBlockingStub newBlockingStub(
      io.grpc.Channel channel) {
    io.grpc.stub.AbstractStub.StubFactory<ExecutionServiceBlockingStub> factory =
      new io.grpc.stub.AbstractStub.StubFactory<ExecutionServiceBlockingStub>() {
        @java.lang.Override
        public ExecutionServiceBlockingStub newStub(io.grpc.Channel channel, io.grpc.CallOptions callOptions) {
          return new ExecutionServiceBlockingStub(channel, callOptions);
        }
      };
    return ExecutionServiceBlockingStub.newStub(factory, channel);
  }

  /**
   * Creates a new ListenableFuture-style stub that supports unary calls on the service
   */
  public static ExecutionServiceFutureStub newFutureStub(
      io.grpc.Channel channel) {
    io.grpc.stub.AbstractStub.StubFactory<ExecutionServiceFutureStub> factory =
      new io.grpc.stub.AbstractStub.StubFactory<ExecutionServiceFutureStub>() {
        @java.lang.Override
        public ExecutionServiceFutureStub newStub(io.grpc.Channel channel, io.grpc.CallOptions callOptions) {
          return new ExecutionServiceFutureStub(channel, callOptions);
        }
      };
    return ExecutionServiceFutureStub.newStub(factory, channel);
  }

  /**
   */
  public interface AsyncService {

    /**
     */
    default void createSession(org.ferretlang.jetbrains.protocol.ferretd.execution.v1.CreateSessionRequest request,
        io.grpc.stub.StreamObserver<org.ferretlang.jetbrains.protocol.ferretd.execution.v1.CreateSessionResponse> responseObserver) {
      io.grpc.stub.ServerCalls.asyncUnimplementedUnaryCall(getCreateSessionMethod(), responseObserver);
    }

    /**
     */
    default void getSession(org.ferretlang.jetbrains.protocol.ferretd.execution.v1.GetSessionRequest request,
        io.grpc.stub.StreamObserver<org.ferretlang.jetbrains.protocol.ferretd.execution.v1.GetSessionResponse> responseObserver) {
      io.grpc.stub.ServerCalls.asyncUnimplementedUnaryCall(getGetSessionMethod(), responseObserver);
    }

    /**
     */
    default void closeSession(org.ferretlang.jetbrains.protocol.ferretd.execution.v1.CloseSessionRequest request,
        io.grpc.stub.StreamObserver<org.ferretlang.jetbrains.protocol.ferretd.execution.v1.CloseSessionResponse> responseObserver) {
      io.grpc.stub.ServerCalls.asyncUnimplementedUnaryCall(getCloseSessionMethod(), responseObserver);
    }

    /**
     */
    default void createExecution(org.ferretlang.jetbrains.protocol.ferretd.execution.v1.CreateExecutionRequest request,
        io.grpc.stub.StreamObserver<org.ferretlang.jetbrains.protocol.ferretd.execution.v1.CreateExecutionResponse> responseObserver) {
      io.grpc.stub.ServerCalls.asyncUnimplementedUnaryCall(getCreateExecutionMethod(), responseObserver);
    }

    /**
     */
    default void runExecution(org.ferretlang.jetbrains.protocol.ferretd.execution.v1.RunExecutionRequest request,
        io.grpc.stub.StreamObserver<org.ferretlang.jetbrains.protocol.ferretd.execution.v1.RunExecutionResponse> responseObserver) {
      io.grpc.stub.ServerCalls.asyncUnimplementedUnaryCall(getRunExecutionMethod(), responseObserver);
    }

    /**
     */
    default void getExecution(org.ferretlang.jetbrains.protocol.ferretd.execution.v1.GetExecutionRequest request,
        io.grpc.stub.StreamObserver<org.ferretlang.jetbrains.protocol.ferretd.execution.v1.GetExecutionResponse> responseObserver) {
      io.grpc.stub.ServerCalls.asyncUnimplementedUnaryCall(getGetExecutionMethod(), responseObserver);
    }

    /**
     */
    default void cancelExecution(org.ferretlang.jetbrains.protocol.ferretd.execution.v1.CancelExecutionRequest request,
        io.grpc.stub.StreamObserver<org.ferretlang.jetbrains.protocol.ferretd.execution.v1.CancelExecutionResponse> responseObserver) {
      io.grpc.stub.ServerCalls.asyncUnimplementedUnaryCall(getCancelExecutionMethod(), responseObserver);
    }

    /**
     */
    default void closeExecution(org.ferretlang.jetbrains.protocol.ferretd.execution.v1.CloseExecutionRequest request,
        io.grpc.stub.StreamObserver<org.ferretlang.jetbrains.protocol.ferretd.execution.v1.CloseExecutionResponse> responseObserver) {
      io.grpc.stub.ServerCalls.asyncUnimplementedUnaryCall(getCloseExecutionMethod(), responseObserver);
    }

    /**
     */
    default void watchExecution(org.ferretlang.jetbrains.protocol.ferretd.execution.v1.WatchExecutionRequest request,
        io.grpc.stub.StreamObserver<org.ferretlang.jetbrains.protocol.ferretd.execution.v1.WatchExecutionResponse> responseObserver) {
      io.grpc.stub.ServerCalls.asyncUnimplementedUnaryCall(getWatchExecutionMethod(), responseObserver);
    }
  }

  /**
   * Base class for the server implementation of the service ExecutionService.
   */
  public static abstract class ExecutionServiceImplBase
      implements io.grpc.BindableService, AsyncService {

    @java.lang.Override public final io.grpc.ServerServiceDefinition bindService() {
      return ExecutionServiceGrpc.bindService(this);
    }
  }

  /**
   * A stub to allow clients to do asynchronous rpc calls to service ExecutionService.
   */
  public static final class ExecutionServiceStub
      extends io.grpc.stub.AbstractAsyncStub<ExecutionServiceStub> {
    private ExecutionServiceStub(
        io.grpc.Channel channel, io.grpc.CallOptions callOptions) {
      super(channel, callOptions);
    }

    @java.lang.Override
    protected ExecutionServiceStub build(
        io.grpc.Channel channel, io.grpc.CallOptions callOptions) {
      return new ExecutionServiceStub(channel, callOptions);
    }

    /**
     */
    public void createSession(org.ferretlang.jetbrains.protocol.ferretd.execution.v1.CreateSessionRequest request,
        io.grpc.stub.StreamObserver<org.ferretlang.jetbrains.protocol.ferretd.execution.v1.CreateSessionResponse> responseObserver) {
      io.grpc.stub.ClientCalls.asyncUnaryCall(
          getChannel().newCall(getCreateSessionMethod(), getCallOptions()), request, responseObserver);
    }

    /**
     */
    public void getSession(org.ferretlang.jetbrains.protocol.ferretd.execution.v1.GetSessionRequest request,
        io.grpc.stub.StreamObserver<org.ferretlang.jetbrains.protocol.ferretd.execution.v1.GetSessionResponse> responseObserver) {
      io.grpc.stub.ClientCalls.asyncUnaryCall(
          getChannel().newCall(getGetSessionMethod(), getCallOptions()), request, responseObserver);
    }

    /**
     */
    public void closeSession(org.ferretlang.jetbrains.protocol.ferretd.execution.v1.CloseSessionRequest request,
        io.grpc.stub.StreamObserver<org.ferretlang.jetbrains.protocol.ferretd.execution.v1.CloseSessionResponse> responseObserver) {
      io.grpc.stub.ClientCalls.asyncUnaryCall(
          getChannel().newCall(getCloseSessionMethod(), getCallOptions()), request, responseObserver);
    }

    /**
     */
    public void createExecution(org.ferretlang.jetbrains.protocol.ferretd.execution.v1.CreateExecutionRequest request,
        io.grpc.stub.StreamObserver<org.ferretlang.jetbrains.protocol.ferretd.execution.v1.CreateExecutionResponse> responseObserver) {
      io.grpc.stub.ClientCalls.asyncUnaryCall(
          getChannel().newCall(getCreateExecutionMethod(), getCallOptions()), request, responseObserver);
    }

    /**
     */
    public void runExecution(org.ferretlang.jetbrains.protocol.ferretd.execution.v1.RunExecutionRequest request,
        io.grpc.stub.StreamObserver<org.ferretlang.jetbrains.protocol.ferretd.execution.v1.RunExecutionResponse> responseObserver) {
      io.grpc.stub.ClientCalls.asyncUnaryCall(
          getChannel().newCall(getRunExecutionMethod(), getCallOptions()), request, responseObserver);
    }

    /**
     */
    public void getExecution(org.ferretlang.jetbrains.protocol.ferretd.execution.v1.GetExecutionRequest request,
        io.grpc.stub.StreamObserver<org.ferretlang.jetbrains.protocol.ferretd.execution.v1.GetExecutionResponse> responseObserver) {
      io.grpc.stub.ClientCalls.asyncUnaryCall(
          getChannel().newCall(getGetExecutionMethod(), getCallOptions()), request, responseObserver);
    }

    /**
     */
    public void cancelExecution(org.ferretlang.jetbrains.protocol.ferretd.execution.v1.CancelExecutionRequest request,
        io.grpc.stub.StreamObserver<org.ferretlang.jetbrains.protocol.ferretd.execution.v1.CancelExecutionResponse> responseObserver) {
      io.grpc.stub.ClientCalls.asyncUnaryCall(
          getChannel().newCall(getCancelExecutionMethod(), getCallOptions()), request, responseObserver);
    }

    /**
     */
    public void closeExecution(org.ferretlang.jetbrains.protocol.ferretd.execution.v1.CloseExecutionRequest request,
        io.grpc.stub.StreamObserver<org.ferretlang.jetbrains.protocol.ferretd.execution.v1.CloseExecutionResponse> responseObserver) {
      io.grpc.stub.ClientCalls.asyncUnaryCall(
          getChannel().newCall(getCloseExecutionMethod(), getCallOptions()), request, responseObserver);
    }

    /**
     */
    public void watchExecution(org.ferretlang.jetbrains.protocol.ferretd.execution.v1.WatchExecutionRequest request,
        io.grpc.stub.StreamObserver<org.ferretlang.jetbrains.protocol.ferretd.execution.v1.WatchExecutionResponse> responseObserver) {
      io.grpc.stub.ClientCalls.asyncServerStreamingCall(
          getChannel().newCall(getWatchExecutionMethod(), getCallOptions()), request, responseObserver);
    }
  }

  /**
   * A stub to allow clients to do synchronous rpc calls to service ExecutionService.
   */
  public static final class ExecutionServiceBlockingV2Stub
      extends io.grpc.stub.AbstractBlockingStub<ExecutionServiceBlockingV2Stub> {
    private ExecutionServiceBlockingV2Stub(
        io.grpc.Channel channel, io.grpc.CallOptions callOptions) {
      super(channel, callOptions);
    }

    @java.lang.Override
    protected ExecutionServiceBlockingV2Stub build(
        io.grpc.Channel channel, io.grpc.CallOptions callOptions) {
      return new ExecutionServiceBlockingV2Stub(channel, callOptions);
    }

    /**
     */
    public org.ferretlang.jetbrains.protocol.ferretd.execution.v1.CreateSessionResponse createSession(org.ferretlang.jetbrains.protocol.ferretd.execution.v1.CreateSessionRequest request) throws io.grpc.StatusException {
      return io.grpc.stub.ClientCalls.blockingV2UnaryCall(
          getChannel(), getCreateSessionMethod(), getCallOptions(), request);
    }

    /**
     */
    public org.ferretlang.jetbrains.protocol.ferretd.execution.v1.GetSessionResponse getSession(org.ferretlang.jetbrains.protocol.ferretd.execution.v1.GetSessionRequest request) throws io.grpc.StatusException {
      return io.grpc.stub.ClientCalls.blockingV2UnaryCall(
          getChannel(), getGetSessionMethod(), getCallOptions(), request);
    }

    /**
     */
    public org.ferretlang.jetbrains.protocol.ferretd.execution.v1.CloseSessionResponse closeSession(org.ferretlang.jetbrains.protocol.ferretd.execution.v1.CloseSessionRequest request) throws io.grpc.StatusException {
      return io.grpc.stub.ClientCalls.blockingV2UnaryCall(
          getChannel(), getCloseSessionMethod(), getCallOptions(), request);
    }

    /**
     */
    public org.ferretlang.jetbrains.protocol.ferretd.execution.v1.CreateExecutionResponse createExecution(org.ferretlang.jetbrains.protocol.ferretd.execution.v1.CreateExecutionRequest request) throws io.grpc.StatusException {
      return io.grpc.stub.ClientCalls.blockingV2UnaryCall(
          getChannel(), getCreateExecutionMethod(), getCallOptions(), request);
    }

    /**
     */
    public org.ferretlang.jetbrains.protocol.ferretd.execution.v1.RunExecutionResponse runExecution(org.ferretlang.jetbrains.protocol.ferretd.execution.v1.RunExecutionRequest request) throws io.grpc.StatusException {
      return io.grpc.stub.ClientCalls.blockingV2UnaryCall(
          getChannel(), getRunExecutionMethod(), getCallOptions(), request);
    }

    /**
     */
    public org.ferretlang.jetbrains.protocol.ferretd.execution.v1.GetExecutionResponse getExecution(org.ferretlang.jetbrains.protocol.ferretd.execution.v1.GetExecutionRequest request) throws io.grpc.StatusException {
      return io.grpc.stub.ClientCalls.blockingV2UnaryCall(
          getChannel(), getGetExecutionMethod(), getCallOptions(), request);
    }

    /**
     */
    public org.ferretlang.jetbrains.protocol.ferretd.execution.v1.CancelExecutionResponse cancelExecution(org.ferretlang.jetbrains.protocol.ferretd.execution.v1.CancelExecutionRequest request) throws io.grpc.StatusException {
      return io.grpc.stub.ClientCalls.blockingV2UnaryCall(
          getChannel(), getCancelExecutionMethod(), getCallOptions(), request);
    }

    /**
     */
    public org.ferretlang.jetbrains.protocol.ferretd.execution.v1.CloseExecutionResponse closeExecution(org.ferretlang.jetbrains.protocol.ferretd.execution.v1.CloseExecutionRequest request) throws io.grpc.StatusException {
      return io.grpc.stub.ClientCalls.blockingV2UnaryCall(
          getChannel(), getCloseExecutionMethod(), getCallOptions(), request);
    }

    /**
     */
    @io.grpc.ExperimentalApi("https://github.com/grpc/grpc-java/issues/10918")
    public io.grpc.stub.BlockingClientCall<?, org.ferretlang.jetbrains.protocol.ferretd.execution.v1.WatchExecutionResponse>
        watchExecution(org.ferretlang.jetbrains.protocol.ferretd.execution.v1.WatchExecutionRequest request) {
      return io.grpc.stub.ClientCalls.blockingV2ServerStreamingCall(
          getChannel(), getWatchExecutionMethod(), getCallOptions(), request);
    }
  }

  /**
   * A stub to allow clients to do limited synchronous rpc calls to service ExecutionService.
   */
  public static final class ExecutionServiceBlockingStub
      extends io.grpc.stub.AbstractBlockingStub<ExecutionServiceBlockingStub> {
    private ExecutionServiceBlockingStub(
        io.grpc.Channel channel, io.grpc.CallOptions callOptions) {
      super(channel, callOptions);
    }

    @java.lang.Override
    protected ExecutionServiceBlockingStub build(
        io.grpc.Channel channel, io.grpc.CallOptions callOptions) {
      return new ExecutionServiceBlockingStub(channel, callOptions);
    }

    /**
     */
    public org.ferretlang.jetbrains.protocol.ferretd.execution.v1.CreateSessionResponse createSession(org.ferretlang.jetbrains.protocol.ferretd.execution.v1.CreateSessionRequest request) {
      return io.grpc.stub.ClientCalls.blockingUnaryCall(
          getChannel(), getCreateSessionMethod(), getCallOptions(), request);
    }

    /**
     */
    public org.ferretlang.jetbrains.protocol.ferretd.execution.v1.GetSessionResponse getSession(org.ferretlang.jetbrains.protocol.ferretd.execution.v1.GetSessionRequest request) {
      return io.grpc.stub.ClientCalls.blockingUnaryCall(
          getChannel(), getGetSessionMethod(), getCallOptions(), request);
    }

    /**
     */
    public org.ferretlang.jetbrains.protocol.ferretd.execution.v1.CloseSessionResponse closeSession(org.ferretlang.jetbrains.protocol.ferretd.execution.v1.CloseSessionRequest request) {
      return io.grpc.stub.ClientCalls.blockingUnaryCall(
          getChannel(), getCloseSessionMethod(), getCallOptions(), request);
    }

    /**
     */
    public org.ferretlang.jetbrains.protocol.ferretd.execution.v1.CreateExecutionResponse createExecution(org.ferretlang.jetbrains.protocol.ferretd.execution.v1.CreateExecutionRequest request) {
      return io.grpc.stub.ClientCalls.blockingUnaryCall(
          getChannel(), getCreateExecutionMethod(), getCallOptions(), request);
    }

    /**
     */
    public org.ferretlang.jetbrains.protocol.ferretd.execution.v1.RunExecutionResponse runExecution(org.ferretlang.jetbrains.protocol.ferretd.execution.v1.RunExecutionRequest request) {
      return io.grpc.stub.ClientCalls.blockingUnaryCall(
          getChannel(), getRunExecutionMethod(), getCallOptions(), request);
    }

    /**
     */
    public org.ferretlang.jetbrains.protocol.ferretd.execution.v1.GetExecutionResponse getExecution(org.ferretlang.jetbrains.protocol.ferretd.execution.v1.GetExecutionRequest request) {
      return io.grpc.stub.ClientCalls.blockingUnaryCall(
          getChannel(), getGetExecutionMethod(), getCallOptions(), request);
    }

    /**
     */
    public org.ferretlang.jetbrains.protocol.ferretd.execution.v1.CancelExecutionResponse cancelExecution(org.ferretlang.jetbrains.protocol.ferretd.execution.v1.CancelExecutionRequest request) {
      return io.grpc.stub.ClientCalls.blockingUnaryCall(
          getChannel(), getCancelExecutionMethod(), getCallOptions(), request);
    }

    /**
     */
    public org.ferretlang.jetbrains.protocol.ferretd.execution.v1.CloseExecutionResponse closeExecution(org.ferretlang.jetbrains.protocol.ferretd.execution.v1.CloseExecutionRequest request) {
      return io.grpc.stub.ClientCalls.blockingUnaryCall(
          getChannel(), getCloseExecutionMethod(), getCallOptions(), request);
    }

    /**
     */
    public java.util.Iterator<org.ferretlang.jetbrains.protocol.ferretd.execution.v1.WatchExecutionResponse> watchExecution(
        org.ferretlang.jetbrains.protocol.ferretd.execution.v1.WatchExecutionRequest request) {
      return io.grpc.stub.ClientCalls.blockingServerStreamingCall(
          getChannel(), getWatchExecutionMethod(), getCallOptions(), request);
    }
  }

  /**
   * A stub to allow clients to do ListenableFuture-style rpc calls to service ExecutionService.
   */
  public static final class ExecutionServiceFutureStub
      extends io.grpc.stub.AbstractFutureStub<ExecutionServiceFutureStub> {
    private ExecutionServiceFutureStub(
        io.grpc.Channel channel, io.grpc.CallOptions callOptions) {
      super(channel, callOptions);
    }

    @java.lang.Override
    protected ExecutionServiceFutureStub build(
        io.grpc.Channel channel, io.grpc.CallOptions callOptions) {
      return new ExecutionServiceFutureStub(channel, callOptions);
    }

    /**
     */
    public com.google.common.util.concurrent.ListenableFuture<org.ferretlang.jetbrains.protocol.ferretd.execution.v1.CreateSessionResponse> createSession(
        org.ferretlang.jetbrains.protocol.ferretd.execution.v1.CreateSessionRequest request) {
      return io.grpc.stub.ClientCalls.futureUnaryCall(
          getChannel().newCall(getCreateSessionMethod(), getCallOptions()), request);
    }

    /**
     */
    public com.google.common.util.concurrent.ListenableFuture<org.ferretlang.jetbrains.protocol.ferretd.execution.v1.GetSessionResponse> getSession(
        org.ferretlang.jetbrains.protocol.ferretd.execution.v1.GetSessionRequest request) {
      return io.grpc.stub.ClientCalls.futureUnaryCall(
          getChannel().newCall(getGetSessionMethod(), getCallOptions()), request);
    }

    /**
     */
    public com.google.common.util.concurrent.ListenableFuture<org.ferretlang.jetbrains.protocol.ferretd.execution.v1.CloseSessionResponse> closeSession(
        org.ferretlang.jetbrains.protocol.ferretd.execution.v1.CloseSessionRequest request) {
      return io.grpc.stub.ClientCalls.futureUnaryCall(
          getChannel().newCall(getCloseSessionMethod(), getCallOptions()), request);
    }

    /**
     */
    public com.google.common.util.concurrent.ListenableFuture<org.ferretlang.jetbrains.protocol.ferretd.execution.v1.CreateExecutionResponse> createExecution(
        org.ferretlang.jetbrains.protocol.ferretd.execution.v1.CreateExecutionRequest request) {
      return io.grpc.stub.ClientCalls.futureUnaryCall(
          getChannel().newCall(getCreateExecutionMethod(), getCallOptions()), request);
    }

    /**
     */
    public com.google.common.util.concurrent.ListenableFuture<org.ferretlang.jetbrains.protocol.ferretd.execution.v1.RunExecutionResponse> runExecution(
        org.ferretlang.jetbrains.protocol.ferretd.execution.v1.RunExecutionRequest request) {
      return io.grpc.stub.ClientCalls.futureUnaryCall(
          getChannel().newCall(getRunExecutionMethod(), getCallOptions()), request);
    }

    /**
     */
    public com.google.common.util.concurrent.ListenableFuture<org.ferretlang.jetbrains.protocol.ferretd.execution.v1.GetExecutionResponse> getExecution(
        org.ferretlang.jetbrains.protocol.ferretd.execution.v1.GetExecutionRequest request) {
      return io.grpc.stub.ClientCalls.futureUnaryCall(
          getChannel().newCall(getGetExecutionMethod(), getCallOptions()), request);
    }

    /**
     */
    public com.google.common.util.concurrent.ListenableFuture<org.ferretlang.jetbrains.protocol.ferretd.execution.v1.CancelExecutionResponse> cancelExecution(
        org.ferretlang.jetbrains.protocol.ferretd.execution.v1.CancelExecutionRequest request) {
      return io.grpc.stub.ClientCalls.futureUnaryCall(
          getChannel().newCall(getCancelExecutionMethod(), getCallOptions()), request);
    }

    /**
     */
    public com.google.common.util.concurrent.ListenableFuture<org.ferretlang.jetbrains.protocol.ferretd.execution.v1.CloseExecutionResponse> closeExecution(
        org.ferretlang.jetbrains.protocol.ferretd.execution.v1.CloseExecutionRequest request) {
      return io.grpc.stub.ClientCalls.futureUnaryCall(
          getChannel().newCall(getCloseExecutionMethod(), getCallOptions()), request);
    }
  }

  private static final int METHODID_CREATE_SESSION = 0;
  private static final int METHODID_GET_SESSION = 1;
  private static final int METHODID_CLOSE_SESSION = 2;
  private static final int METHODID_CREATE_EXECUTION = 3;
  private static final int METHODID_RUN_EXECUTION = 4;
  private static final int METHODID_GET_EXECUTION = 5;
  private static final int METHODID_CANCEL_EXECUTION = 6;
  private static final int METHODID_CLOSE_EXECUTION = 7;
  private static final int METHODID_WATCH_EXECUTION = 8;

  private static final class MethodHandlers<Req, Resp> implements
      io.grpc.stub.ServerCalls.UnaryMethod<Req, Resp>,
      io.grpc.stub.ServerCalls.ServerStreamingMethod<Req, Resp>,
      io.grpc.stub.ServerCalls.ClientStreamingMethod<Req, Resp>,
      io.grpc.stub.ServerCalls.BidiStreamingMethod<Req, Resp> {
    private final AsyncService serviceImpl;
    private final int methodId;

    MethodHandlers(AsyncService serviceImpl, int methodId) {
      this.serviceImpl = serviceImpl;
      this.methodId = methodId;
    }

    @java.lang.Override
    @java.lang.SuppressWarnings("unchecked")
    public void invoke(Req request, io.grpc.stub.StreamObserver<Resp> responseObserver) {
      switch (methodId) {
        case METHODID_CREATE_SESSION:
          serviceImpl.createSession((org.ferretlang.jetbrains.protocol.ferretd.execution.v1.CreateSessionRequest) request,
              (io.grpc.stub.StreamObserver<org.ferretlang.jetbrains.protocol.ferretd.execution.v1.CreateSessionResponse>) responseObserver);
          break;
        case METHODID_GET_SESSION:
          serviceImpl.getSession((org.ferretlang.jetbrains.protocol.ferretd.execution.v1.GetSessionRequest) request,
              (io.grpc.stub.StreamObserver<org.ferretlang.jetbrains.protocol.ferretd.execution.v1.GetSessionResponse>) responseObserver);
          break;
        case METHODID_CLOSE_SESSION:
          serviceImpl.closeSession((org.ferretlang.jetbrains.protocol.ferretd.execution.v1.CloseSessionRequest) request,
              (io.grpc.stub.StreamObserver<org.ferretlang.jetbrains.protocol.ferretd.execution.v1.CloseSessionResponse>) responseObserver);
          break;
        case METHODID_CREATE_EXECUTION:
          serviceImpl.createExecution((org.ferretlang.jetbrains.protocol.ferretd.execution.v1.CreateExecutionRequest) request,
              (io.grpc.stub.StreamObserver<org.ferretlang.jetbrains.protocol.ferretd.execution.v1.CreateExecutionResponse>) responseObserver);
          break;
        case METHODID_RUN_EXECUTION:
          serviceImpl.runExecution((org.ferretlang.jetbrains.protocol.ferretd.execution.v1.RunExecutionRequest) request,
              (io.grpc.stub.StreamObserver<org.ferretlang.jetbrains.protocol.ferretd.execution.v1.RunExecutionResponse>) responseObserver);
          break;
        case METHODID_GET_EXECUTION:
          serviceImpl.getExecution((org.ferretlang.jetbrains.protocol.ferretd.execution.v1.GetExecutionRequest) request,
              (io.grpc.stub.StreamObserver<org.ferretlang.jetbrains.protocol.ferretd.execution.v1.GetExecutionResponse>) responseObserver);
          break;
        case METHODID_CANCEL_EXECUTION:
          serviceImpl.cancelExecution((org.ferretlang.jetbrains.protocol.ferretd.execution.v1.CancelExecutionRequest) request,
              (io.grpc.stub.StreamObserver<org.ferretlang.jetbrains.protocol.ferretd.execution.v1.CancelExecutionResponse>) responseObserver);
          break;
        case METHODID_CLOSE_EXECUTION:
          serviceImpl.closeExecution((org.ferretlang.jetbrains.protocol.ferretd.execution.v1.CloseExecutionRequest) request,
              (io.grpc.stub.StreamObserver<org.ferretlang.jetbrains.protocol.ferretd.execution.v1.CloseExecutionResponse>) responseObserver);
          break;
        case METHODID_WATCH_EXECUTION:
          serviceImpl.watchExecution((org.ferretlang.jetbrains.protocol.ferretd.execution.v1.WatchExecutionRequest) request,
              (io.grpc.stub.StreamObserver<org.ferretlang.jetbrains.protocol.ferretd.execution.v1.WatchExecutionResponse>) responseObserver);
          break;
        default:
          throw new AssertionError();
      }
    }

    @java.lang.Override
    @java.lang.SuppressWarnings("unchecked")
    public io.grpc.stub.StreamObserver<Req> invoke(
        io.grpc.stub.StreamObserver<Resp> responseObserver) {
      switch (methodId) {
        default:
          throw new AssertionError();
      }
    }
  }

  public static final io.grpc.ServerServiceDefinition bindService(AsyncService service) {
    return io.grpc.ServerServiceDefinition.builder(getServiceDescriptor())
        .addMethod(
          getCreateSessionMethod(),
          io.grpc.stub.ServerCalls.asyncUnaryCall(
            new MethodHandlers<
              org.ferretlang.jetbrains.protocol.ferretd.execution.v1.CreateSessionRequest,
              org.ferretlang.jetbrains.protocol.ferretd.execution.v1.CreateSessionResponse>(
                service, METHODID_CREATE_SESSION)))
        .addMethod(
          getGetSessionMethod(),
          io.grpc.stub.ServerCalls.asyncUnaryCall(
            new MethodHandlers<
              org.ferretlang.jetbrains.protocol.ferretd.execution.v1.GetSessionRequest,
              org.ferretlang.jetbrains.protocol.ferretd.execution.v1.GetSessionResponse>(
                service, METHODID_GET_SESSION)))
        .addMethod(
          getCloseSessionMethod(),
          io.grpc.stub.ServerCalls.asyncUnaryCall(
            new MethodHandlers<
              org.ferretlang.jetbrains.protocol.ferretd.execution.v1.CloseSessionRequest,
              org.ferretlang.jetbrains.protocol.ferretd.execution.v1.CloseSessionResponse>(
                service, METHODID_CLOSE_SESSION)))
        .addMethod(
          getCreateExecutionMethod(),
          io.grpc.stub.ServerCalls.asyncUnaryCall(
            new MethodHandlers<
              org.ferretlang.jetbrains.protocol.ferretd.execution.v1.CreateExecutionRequest,
              org.ferretlang.jetbrains.protocol.ferretd.execution.v1.CreateExecutionResponse>(
                service, METHODID_CREATE_EXECUTION)))
        .addMethod(
          getRunExecutionMethod(),
          io.grpc.stub.ServerCalls.asyncUnaryCall(
            new MethodHandlers<
              org.ferretlang.jetbrains.protocol.ferretd.execution.v1.RunExecutionRequest,
              org.ferretlang.jetbrains.protocol.ferretd.execution.v1.RunExecutionResponse>(
                service, METHODID_RUN_EXECUTION)))
        .addMethod(
          getGetExecutionMethod(),
          io.grpc.stub.ServerCalls.asyncUnaryCall(
            new MethodHandlers<
              org.ferretlang.jetbrains.protocol.ferretd.execution.v1.GetExecutionRequest,
              org.ferretlang.jetbrains.protocol.ferretd.execution.v1.GetExecutionResponse>(
                service, METHODID_GET_EXECUTION)))
        .addMethod(
          getCancelExecutionMethod(),
          io.grpc.stub.ServerCalls.asyncUnaryCall(
            new MethodHandlers<
              org.ferretlang.jetbrains.protocol.ferretd.execution.v1.CancelExecutionRequest,
              org.ferretlang.jetbrains.protocol.ferretd.execution.v1.CancelExecutionResponse>(
                service, METHODID_CANCEL_EXECUTION)))
        .addMethod(
          getCloseExecutionMethod(),
          io.grpc.stub.ServerCalls.asyncUnaryCall(
            new MethodHandlers<
              org.ferretlang.jetbrains.protocol.ferretd.execution.v1.CloseExecutionRequest,
              org.ferretlang.jetbrains.protocol.ferretd.execution.v1.CloseExecutionResponse>(
                service, METHODID_CLOSE_EXECUTION)))
        .addMethod(
          getWatchExecutionMethod(),
          io.grpc.stub.ServerCalls.asyncServerStreamingCall(
            new MethodHandlers<
              org.ferretlang.jetbrains.protocol.ferretd.execution.v1.WatchExecutionRequest,
              org.ferretlang.jetbrains.protocol.ferretd.execution.v1.WatchExecutionResponse>(
                service, METHODID_WATCH_EXECUTION)))
        .build();
  }

  private static abstract class ExecutionServiceBaseDescriptorSupplier
      implements io.grpc.protobuf.ProtoFileDescriptorSupplier, io.grpc.protobuf.ProtoServiceDescriptorSupplier {
    ExecutionServiceBaseDescriptorSupplier() {}

    @java.lang.Override
    public com.google.protobuf.Descriptors.FileDescriptor getFileDescriptor() {
      return org.ferretlang.jetbrains.protocol.ferretd.execution.v1.ExecutionProto.getDescriptor();
    }

    @java.lang.Override
    public com.google.protobuf.Descriptors.ServiceDescriptor getServiceDescriptor() {
      return getFileDescriptor().findServiceByName("ExecutionService");
    }
  }

  private static final class ExecutionServiceFileDescriptorSupplier
      extends ExecutionServiceBaseDescriptorSupplier {
    ExecutionServiceFileDescriptorSupplier() {}
  }

  private static final class ExecutionServiceMethodDescriptorSupplier
      extends ExecutionServiceBaseDescriptorSupplier
      implements io.grpc.protobuf.ProtoMethodDescriptorSupplier {
    private final java.lang.String methodName;

    ExecutionServiceMethodDescriptorSupplier(java.lang.String methodName) {
      this.methodName = methodName;
    }

    @java.lang.Override
    public com.google.protobuf.Descriptors.MethodDescriptor getMethodDescriptor() {
      return getServiceDescriptor().findMethodByName(methodName);
    }
  }

  private static volatile io.grpc.ServiceDescriptor serviceDescriptor;

  public static io.grpc.ServiceDescriptor getServiceDescriptor() {
    io.grpc.ServiceDescriptor result = serviceDescriptor;
    if (result == null) {
      synchronized (ExecutionServiceGrpc.class) {
        result = serviceDescriptor;
        if (result == null) {
          serviceDescriptor = result = io.grpc.ServiceDescriptor.newBuilder(SERVICE_NAME)
              .setSchemaDescriptor(new ExecutionServiceFileDescriptorSupplier())
              .addMethod(getCreateSessionMethod())
              .addMethod(getGetSessionMethod())
              .addMethod(getCloseSessionMethod())
              .addMethod(getCreateExecutionMethod())
              .addMethod(getRunExecutionMethod())
              .addMethod(getGetExecutionMethod())
              .addMethod(getCancelExecutionMethod())
              .addMethod(getCloseExecutionMethod())
              .addMethod(getWatchExecutionMethod())
              .build();
        }
      }
    }
    return result;
  }
}
